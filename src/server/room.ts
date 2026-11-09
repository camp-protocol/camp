import { CAMP_VERSION } from '../core/version.ts';
import { ResultCache } from '../core/idempotency.ts';
import type { HelloMessage } from '../core/envelope.ts';
import type {
  AnyVocabulary,
  CommandMessageOf,
  CommandPayloadOf,
  CommandTypeOf,
  EphemeralMessageOf,
  EventTypeOf,
  RejectReasonOf,
  SignalMessageOf,
  SignalPayloadOf,
  SignalTypeOf,
  SnapshotOf,
} from '../core/vocabulary.ts';
import type { Connection, RoomEndpoint } from './transport.ts';
import { createResumeToken, resumeTokenMatches } from './resume-token.ts';

/**
 * 小さなアプリ向けの、すぐ使える部屋（RoomEndpoint の実装）。
 *  - 部屋ごとに1件ずつ処理する（Node の1本の流れの上で、ハンドラは同期的に動く）
 *  - 状態が変わるたびに連番 seq を振り、状態の全体を同封して全員に配る
 *  - 同じ commandId の再送は実行せず、前回の結果を返す
 *  - 遅い処理（AI など）は task() で走らせ、reset() 前に始まった結果は捨てる
 *  - 参加者の席・ホストの交代・満員のときの観覧を受け持つ
 * 状態の保存はしない（必要ならアプリが RoomEndpoint を自前で実装する。IDEA AUDITION の SessionActor がその例）。
 */

export interface Participant {
  id: string;
  connected: boolean;
  isHost: boolean;
  joinedAt: number;
}

/** reject() が返す印。ハンドラはこれを return すると、状態を変えずに理由を返せる */
export interface Rejection {
  readonly rejected: true;
  readonly reason: string;
}

export interface RoomApi<V extends AnyVocabulary, S> {
  /** 状態。ハンドラの中で直接書き換えてよい（書き換えたら emit で知らせる） */
  state: S;
  readonly id: string;
  readonly participants: readonly Participant[];
  isHost(participantId: string): boolean;
  reject(reason: RejectReasonOf<V>): Rejection;
  /** 起きたことを全員に配る（連番と状態の全体つき） */
  emit(type: EventTypeOf<V>, detail?: Record<string, unknown>): void;
  /** 遅い処理を走らせ、終わったら then を部屋の順番の中で呼ぶ。reset() をまたいだ結果は捨てる */
  task<T>(work: () => Promise<T>, then: (result: T) => void, onError?: (e: unknown) => void): void;
  /** 状態を作り直す。走っている task の結果は捨てられる */
  reset(state: S): void;
}

export interface CommandContext {
  actor: string;
  commandId: string;
  expected?: { rev: string } | undefined;
}

export type CommandHandlers<V extends AnyVocabulary, S> = {
  [K in CommandTypeOf<V>]?: (room: RoomApi<V, S>, payload: CommandPayloadOf<V, K>, ctx: CommandContext) => Rejection | void;
};

export type SignalHandlers<V extends AnyVocabulary, S> = {
  [K in SignalTypeOf<V>]?: (room: RoomApi<V, S>, payload: SignalPayloadOf<V, K>, actor: string) => void;
};

export interface RoomDefinition<V extends AnyVocabulary, S> {
  initialState: () => S;
  commands: CommandHandlers<V, S>;
  signals?: SignalHandlers<V, S>;
  /** 状態 → 全員に配る snapshot。既定は { ...state, seq, participants } */
  snapshot?: (state: S, info: { seq: number; participants: readonly Participant[] }) => SnapshotOf<V>;
  onJoin?: (room: RoomApi<V, S>, participantId: string, rejoined: boolean) => void;
  onLeave?: (room: RoomApi<V, S>, participantId: string) => void;
  /** 操作できる人数。超えた人は観覧（participantId: null） */
  maxParticipants?: number;
  /** Signal を1人あたり1秒に受け付ける件数 */
  signalsPerSecond?: number;
}

export class CampRoom<V extends AnyVocabulary, S> implements RoomEndpoint<V> {
  private seq = 0;
  private epoch = 0;
  private nextParticipant = 0;
  private connections = new Map<string, { conn: Connection; participantId: string | null }>();
  private people: Participant[] = [];
  /** 参加者ごとのつなぎ直し用の合言葉（snapshot には入れない） */
  private tokens = new Map<string, string>();
  private results = new ResultCache<unknown>(500);
  private signalTimes = new Map<string, number[]>();
  private api: RoomApi<V, S>;
  state: S;

  constructor(
    readonly id: string,
    private readonly def: RoomDefinition<V, S>,
    private readonly now: () => number = Date.now,
  ) {
    this.state = def.initialState();
    const room = this;
    this.api = {
      get state() {
        return room.state;
      },
      set state(s: S) {
        room.state = s;
      },
      id,
      get participants() {
        return room.people;
      },
      isHost: (pid) => room.people.some((p) => p.id === pid && p.isHost),
      reject: (reason) => ({ rejected: true, reason: reason as string }),
      emit: (type, detail = {}) => room.emit(type as string, detail, null, null),
      task: (work, then, onError) => {
        const epoch = room.epoch;
        // 結果を反映する処理が例外を出しても、受け止めて記録する（受け止めないとプロセスごと止まる）
        const safely = (f: () => void) => {
          try {
            f();
          } catch (e) {
            console.error('[camp] task callback failed', e);
          }
        };
        Promise.resolve()
          .then(work)
          .then(
            (r) => epoch === room.epoch && safely(() => then(r)),
            (e) => epoch === room.epoch && safely(() => onError?.(e)),
          );
      },
      reset: (s) => {
        room.epoch++;
        room.state = s;
      },
    };
  }

  get connectionCount() {
    return this.connections.size;
  }

  snapshot(): SnapshotOf<V> {
    const info = { seq: this.seq, participants: this.people };
    return this.def.snapshot
      ? this.def.snapshot(this.state, info)
      : ({ ...(this.state as object), seq: this.seq, participants: this.people } as SnapshotOf<V>);
  }

  attach(conn: Connection, hello: HelloMessage) {
    const max = this.def.maxParticipants ?? 8;
    // 同じ人として戻れるのは、welcome で渡した合言葉を返してきたときだけ（参加者 ID はほかの人にも見えている）
    let person = hello.participantId ? this.people.find((p) => p.id === hello.participantId) : undefined;
    if (person && !resumeTokenMatches(this.tokens.get(person.id), hello.resumeToken)) person = undefined;
    const rejoined = !!person;
    if (person) person.connected = true;
    else {
      if (this.people.length >= max) {
        // 切断した人の席を空ける。全員接続中なら観覧
        const stale = this.people.find((p) => !p.connected);
        if (stale) {
          this.people = this.people.filter((p) => p !== stale);
          this.tokens.delete(stale.id);
        }
      }
      if (this.people.length < max) {
        person = { id: `p_${++this.nextParticipant}`, connected: true, isHost: false, joinedAt: this.now() };
        this.people.push(person);
        this.tokens.set(person.id, createResumeToken());
      }
    }
    this.ensureHost();
    this.connections.set(conn.id, { conn, participantId: person?.id ?? null });
    conn.send({
      camp: CAMP_VERSION,
      kind: 'welcome',
      participantId: person?.id ?? null,
      resumeToken: person ? (this.tokens.get(person.id) ?? null) : null,
      snapshot: this.snapshot(),
    });
    if (person) this.def.onJoin?.(this.api, person.id, rejoined);
  }

  detach(conn: Connection) {
    const entry = this.connections.get(conn.id);
    this.connections.delete(conn.id);
    const pid = entry?.participantId;
    if (!pid || [...this.connections.values()].some((c) => c.participantId === pid)) return;
    const person = this.people.find((p) => p.id === pid);
    if (person) {
      person.connected = false;
      if (person.isHost) person.isHost = false;
    }
    this.ensureHost();
    this.def.onLeave?.(this.api, pid);
  }

  receiveCommand(conn: Connection, msg: CommandMessageOf<V>) {
    const pid = this.connections.get(conn.id)?.participantId ?? null;
    const sender = pid ?? conn.id;
    const cached = this.results.get(sender, msg.commandId);
    if (cached) return conn.send(cached);
    const reason = this.execute(pid, msg);
    const result = { camp: CAMP_VERSION, kind: 'result', commandId: msg.commandId, ok: reason === null, reason };
    this.results.set(sender, msg.commandId, result);
    conn.send(result);
  }

  private execute(pid: string | null, msg: CommandMessageOf<V>): string | null {
    if (!pid) return 'SPECTATOR';
    const handler = (this.def.commands as Record<string, CommandHandlers<V, S>[CommandTypeOf<V>]>)[msg.type];
    if (!handler) return 'UNKNOWN_TYPE';
    try {
      const out = handler(this.api, msg.payload as never, { actor: pid, commandId: msg.commandId, expected: msg.expected });
      return out && out.rejected ? out.reason : null;
    } catch (e) {
      console.error('[camp] command handler failed', e);
      return 'INVALID_PAYLOAD';
    }
  }

  receiveEphemeral(conn: Connection, msg: EphemeralMessageOf<V>) {
    const pid = this.connections.get(conn.id)?.participantId;
    if (!pid) return;
    const out = { ...msg, senderId: pid };
    for (const { conn: c } of this.connections.values()) if (c.id !== conn.id) c.send(out);
  }

  receiveSignal(conn: Connection, msg: SignalMessageOf<V>) {
    const pid = this.connections.get(conn.id)?.participantId;
    if (!pid) return;
    const now = this.now();
    const recent = (this.signalTimes.get(pid) ?? []).filter((t) => now - t < 1000);
    if (recent.length >= (this.def.signalsPerSecond ?? 2)) return;
    recent.push(now);
    this.signalTimes.set(pid, recent);
    const handler = (this.def.signals as Record<string, ((room: RoomApi<V, S>, payload: unknown, actor: string) => void) | undefined> | undefined)?.[msg.type];
    handler?.(this.api, msg.payload, pid);
  }

  private emit(type: string, detail: Record<string, unknown>, actor: string | null, correlationId: string | null) {
    this.seq++;
    const event = {
      camp: CAMP_VERSION,
      kind: 'event',
      type,
      seq: this.seq,
      correlationId,
      actorId: actor,
      detail,
      snapshot: this.snapshot(),
    };
    for (const { conn } of this.connections.values()) conn.send(event);
  }

  private ensureHost() {
    if (this.people.some((p) => p.isHost && p.connected)) return;
    for (const p of this.people) p.isHost = false;
    const next = this.people.filter((p) => p.connected).sort((a, b) => a.joinedAt - b.joinedAt)[0];
    if (next) next.isHost = true;
  }
}
