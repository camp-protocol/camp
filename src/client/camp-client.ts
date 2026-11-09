import { CAMP_CLOSE, CAMP_VERSION } from '../core/version.ts';
import { SeqGate } from '../core/sequence.ts';
import type { ProtocolErrorMessage } from '../core/envelope.ts';
import type {
  AnyVocabulary,
  CommandMessageOf,
  CommandPayloadOf,
  CommandTypeOf,
  EphemeralMessageOf,
  EphemeralPayloadOf,
  EphemeralTypeOf,
  EventMessageOf,
  RejectReasonOf,
  SignalPayloadOf,
  SignalTypeOf,
  SnapshotOf,
  WelcomeMessageOf,
} from '../core/vocabulary.ts';

/**
 * CAMP のクライアント（docs/protocol/camp-v1.md §5・§8）。ブラウザでも Node でも動く。
 *  - 切断したら指数バックオフ（400ms → 最大5秒）で再接続し、参加者 ID と lastSeq を付けて hello を送る
 *  - result が来ていない Command は、同じ commandId で送り直す（サーバーが重複を排除する）
 *  - 古い・重複した Event は捨てる（SeqGate）
 *  - バージョン違い・部屋が見つからないときは再接続しない
 */

export type ConnectionState = 'connecting' | 'open' | 'reconnecting' | 'closed';
export type CommandOutcome<R = string> = { ok: true } | { ok: false; reason: R | 'TIMEOUT' };

export interface SendOptions {
  /** 画面で見ていた対象の版（違えばサーバーが STALE_VERSION で断る） */
  expected?: { rev: string };
}

/** WebSocket の最小限の形（ブラウザの WebSocket、Node の ws のどちらでもよい） */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(): void;
  onopen: ((ev: unknown) => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number }) => void) | null;
}

export interface CampClientOptions {
  url: string;
  /** 部屋（セッション）の ID */
  room: string;
  /** 前回もらった参加者 ID（再接続・再訪で同じ人として戻る。resumeToken と組で使う） */
  participantId?: string;
  /** 前回の welcome でもらった合言葉（ページを開き直しても同じ人として戻りたいときに保存して渡す） */
  resumeToken?: string;
  /** WebSocket の作り方（Node では ws を渡す。既定は globalThis.WebSocket） */
  createSocket?: (url: string) => WebSocketLike;
  commandTimeoutMs?: number;
  /** 再接続の待ち時間の上限 */
  maxBackoffMs?: number;
}

export interface CampClientHandlers<V extends AnyVocabulary> {
  onWelcome?(m: WelcomeMessageOf<V>): void;
  onEvent?(m: EventMessageOf<V>): void;
  /** welcome と Event のたびに、最新の状態の全体 */
  onSnapshot?(s: SnapshotOf<V>): void;
  onEphemeral?(m: EphemeralMessageOf<V>): void;
  onState?(s: ConnectionState): void;
  /** 部屋が見つからない（リンクが違う・期限切れ）。再接続はしない */
  onRoomNotFound?(): void;
  onProtocolError?(m: ProtocolErrorMessage): void;
}

const OPEN = 1;

function uuid() {
  return globalThis.crypto?.randomUUID?.() ?? `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

export class CampClient<V extends AnyVocabulary> {
  private ws: WebSocketLike | null = null;
  private retry = 0;
  private closed = false;
  private participantId: string | undefined;
  private token: string | undefined;
  private seq = new SeqGate();
  private handlers: CampClientHandlers<V> = {};
  private pending = new Map<
    string,
    { message: unknown; resolve: (o: CommandOutcome<RejectReasonOf<V>>) => void; timer: ReturnType<typeof setTimeout> }
  >();

  constructor(
    private readonly vocabulary: V,
    private readonly opts: CampClientOptions,
  ) {
    this.participantId = opts.participantId;
    this.token = opts.resumeToken;
  }

  /** つなぎ直し用の合言葉（welcome で決まる。ページを開き直しても戻りたいなら participantId と一緒に保存する） */
  get resumeToken() {
    return this.token ?? null;
  }

  /** いまの参加者 ID（welcome で決まる。null は観覧） */
  get id() {
    return this.participantId ?? null;
  }

  get lastSeq() {
    return this.seq.lastSeq;
  }

  on(handlers: CampClientHandlers<V>) {
    this.handlers = { ...this.handlers, ...handlers };
    return this;
  }

  connect() {
    this.closed = false;
    this.handlers.onState?.(this.retry === 0 ? 'connecting' : 'reconnecting');
    const create = this.opts.createSocket ?? ((url: string) => new (globalThis.WebSocket as unknown as new (u: string) => WebSocketLike)(url));
    const ws = create(this.opts.url);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      ws.send(
        JSON.stringify({
          camp: CAMP_VERSION,
          kind: 'hello',
          sessionId: this.opts.room,
          participantId: this.participantId,
          resumeToken: this.token,
          lastSeq: this.seq.lastSeq,
        }),
      );
    };
    ws.onmessage = (e) => this.receive(e.data);
    ws.onclose = (e) => {
      if (this.ws !== ws) return;
      this.ws = null;
      if (e.code === CAMP_CLOSE.UNSUPPORTED_VERSION || e.code === CAMP_CLOSE.ROOM_NOT_FOUND) this.closed = true;
      if (this.closed) {
        this.handlers.onState?.('closed');
        return;
      }
      this.handlers.onState?.('reconnecting');
      const delay = Math.min(this.opts.maxBackoffMs ?? 5000, 400 * 2 ** this.retry++);
      setTimeout(() => this.connect(), delay);
    };
    return this;
  }

  close() {
    this.closed = true;
    this.ws?.close();
  }

  /** Command を送り、result を待つ。切断中に送った分は再接続後に同じ commandId で送り直す */
  send<T extends CommandTypeOf<V>>(type: T, payload: CommandPayloadOf<V, T>, opts: SendOptions = {}): Promise<CommandOutcome<RejectReasonOf<V>>> {
    const message = {
      camp: CAMP_VERSION,
      kind: 'command',
      type,
      commandId: uuid(),
      sentAt: new Date().toISOString(),
      ...(opts.expected ? { expected: opts.expected } : {}),
      payload,
    };
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(message.commandId);
        resolve({ ok: false, reason: 'TIMEOUT' });
      }, this.opts.commandTimeoutMs ?? 8000);
      this.pending.set(message.commandId, { message, resolve, timer });
      this.raw(message);
    });
  }

  /** 保存しない一時的な共有（カーソルなど）。届かなくてもよい */
  sendEphemeral<T extends EphemeralTypeOf<V>>(type: T, payload: EphemeralPayloadOf<V, T>) {
    this.raw({ camp: CAMP_VERSION, kind: 'ephemeral', type, payload });
  }

  /** 返事のいらない曖昧な反応（§3.7）。届かなくてもよい */
  signal<T extends SignalTypeOf<V>>(type: T, payload: SignalPayloadOf<V, T>) {
    this.raw({ camp: CAMP_VERSION, kind: 'signal', type, payload });
  }

  private raw(message: unknown) {
    if (this.ws?.readyState === OPEN) this.ws.send(JSON.stringify(message));
  }

  private receive(data: unknown) {
    let json: unknown;
    try {
      json = JSON.parse(String(data));
    } catch {
      return;
    }
    const parsed = this.vocabulary.ServerMessage.safeParse(json);
    if (!parsed.success) {
      console.warn('[camp] invalid server message', parsed.error.issues[0]);
      return;
    }
    const m = parsed.data as { kind: string } & Record<string, unknown>;
    switch (m.kind) {
      case 'welcome': {
        const w = m as unknown as WelcomeMessageOf<V>;
        this.participantId = (w.participantId as string | null) ?? this.participantId;
        if (w.resumeToken) this.token = w.resumeToken;
        this.seq.reset((w.snapshot as { seq?: number }).seq ?? 0);
        this.handlers.onWelcome?.(w);
        this.handlers.onSnapshot?.(w.snapshot as SnapshotOf<V>);
        this.handlers.onState?.('open');
        for (const p of this.pending.values()) this.raw(p.message);
        break;
      }
      case 'event': {
        const ev = m as unknown as EventMessageOf<V>;
        if (!this.seq.accept(ev.seq as number)) return;
        this.handlers.onEvent?.(ev);
        this.handlers.onSnapshot?.(ev.snapshot as SnapshotOf<V>);
        break;
      }
      case 'result': {
        const r = m as unknown as { commandId: string; ok: boolean; reason: RejectReasonOf<V> | null };
        const p = this.pending.get(r.commandId);
        if (!p) return;
        clearTimeout(p.timer);
        this.pending.delete(r.commandId);
        p.resolve(r.ok ? { ok: true } : { ok: false, reason: (r.reason ?? 'INVALID_PAYLOAD') as RejectReasonOf<V> });
        break;
      }
      case 'ephemeral':
        this.handlers.onEphemeral?.(m as unknown as EphemeralMessageOf<V>);
        break;
      case 'protocol_error': {
        const pe = m as unknown as ProtocolErrorMessage;
        if (pe.code === 'UNSUPPORTED_VERSION') this.closed = true;
        if (pe.code === 'ROOM_NOT_FOUND') {
          this.closed = true;
          this.handlers.onRoomNotFound?.();
        }
        this.handlers.onProtocolError?.(pe);
        break;
      }
    }
  }
}
