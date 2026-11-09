import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocketServer, type WebSocket } from 'ws';
import { CAMP_CLOSE, CAMP_VERSION, SUPPORTED_CAMP_VERSIONS } from '../core/version.ts';
import type { HelloMessage, ProtocolErrorCode } from '../core/envelope.ts';
import type { AnyVocabulary, CommandMessageOf, EphemeralMessageOf, SignalMessageOf } from '../core/vocabulary.ts';

/**
 * CAMP の WebSocket 終端（docs/protocol/camp-v1.md §3・§10・§11）。
 * 形の検証・バージョン・部屋があるか・hello の時間切れ・送りすぎ・生存確認をここで受け持ち、
 * 判定（状態を変えるかどうか）は部屋（RoomEndpoint）に渡す。
 */

export interface Connection {
  readonly id: string;
  send(message: unknown): void;
}

/** 部屋の側が実装するもの。CampRoom（room.ts）か、アプリ独自の実装 */
export interface RoomEndpoint<V extends AnyVocabulary> {
  attach(conn: Connection, hello: HelloMessage): void;
  detach(conn: Connection): void;
  receiveCommand(conn: Connection, msg: CommandMessageOf<V>): void;
  receiveEphemeral(conn: Connection, msg: EphemeralMessageOf<V>): void;
  receiveSignal?(conn: Connection, msg: SignalMessageOf<V>): void;
  readonly connectionCount: number;
}

export interface RoomRegistry<V extends AnyVocabulary> {
  /**
   * 部屋を返す。初回は保存先から復元するなどのため非同期。
   * 部屋がなければ null（接続には ROOM_NOT_FOUND を返して 4404 で閉じる）。
   * 「アプリが作った部屋にだけ入れる」のか「入った人が部屋を作る」のかは、ここで決める。
   */
  get(roomId: string): Promise<RoomEndpoint<V> | null>;
  /** 誰も接続していなくなったとき */
  release(roomId: string): void;
}

export interface TransportOptions<V extends AnyVocabulary> {
  vocabulary: V;
  rooms: RoomRegistry<V>;
  helloTimeoutMs?: number;
  /** 1接続あたり1秒に受け付ける件数 */
  rateLimitPerSec?: number;
  heartbeatMs?: number;
  maxPayloadBytes?: number;
  log?: (m: string) => void;
}

function describe(data: unknown): { kind?: unknown; type?: unknown; camp?: unknown; commandId?: unknown } {
  return data && typeof data === 'object' ? (data as Record<string, unknown>) : {};
}

export function createCampTransport<V extends AnyVocabulary>(opts: TransportOptions<V>) {
  const helloTimeoutMs = opts.helloTimeoutMs ?? 10_000;
  const rateLimit = opts.rateLimitPerSec ?? 120;
  const heartbeatMs = opts.heartbeatMs ?? 25_000;
  const log = opts.log ?? (() => {});
  const wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayloadBytes ?? 64 * 1024 });
  let nextId = 0;

  wss.on('connection', (ws: WebSocket) => {
    const conn: Connection = {
      id: `conn_${++nextId}`,
      send: (m) => {
        if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(m));
      },
    };
    const protocolError = (code: ProtocolErrorCode, detail: string) =>
      conn.send({ camp: CAMP_VERSION, kind: 'protocol_error', code, detail, supported: [...SUPPORTED_CAMP_VERSIONS] });
    // hello 以降のメッセージは、部屋の準備（復元）が終わってから順番どおりに処理する
    let roomReady: Promise<RoomEndpoint<V> | null> | null = null;
    let roomId: string | null = null;
    let closed = false;
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, heartbeatMs);
    const helloTimer = setTimeout(() => {
      if (!roomReady) ws.close(CAMP_CLOSE.HELLO_TIMEOUT, 'hello timeout');
    }, helloTimeoutMs);
    let windowStart = Date.now();
    let received = 0;

    ws.on('message', (raw) => {
      const now = Date.now();
      if (now - windowStart >= 1000) {
        windowStart = now;
        received = 0;
      }
      if (++received > rateLimit) {
        if (received === rateLimit + 1) {
          protocolError('RATE_LIMITED', `more than ${rateLimit} messages per second`);
          ws.close(CAMP_CLOSE.RATE_LIMITED, 'rate limited');
        }
        return;
      }
      let data: unknown;
      try {
        data = JSON.parse(raw.toString());
      } catch {
        protocolError('MALFORMED', 'not JSON');
        return;
      }
      const head = describe(data);
      // バージョンは形の検証より先に見る（違う版の形はこちらでは読めない）
      if (head.camp !== CAMP_VERSION) {
        protocolError('UNSUPPORTED_VERSION', `camp ${JSON.stringify(head.camp ?? null)} is not supported`);
        if (head.kind === 'hello' || !roomReady) ws.close(CAMP_CLOSE.UNSUPPORTED_VERSION, 'unsupported version');
        return;
      }
      const parsed = opts.vocabulary.ClientMessage.safeParse(data);
      if (!parsed.success) {
        if (head.kind === 'command' && typeof head.commandId === 'string') {
          // 知らない type は前方互換のため UNKNOWN_TYPE、知っている type の形違いは INVALID_PAYLOAD
          const reason = opts.vocabulary.hasCommand(head.type) ? 'INVALID_PAYLOAD' : 'UNKNOWN_TYPE';
          conn.send({ camp: CAMP_VERSION, kind: 'result', commandId: head.commandId, ok: false, reason });
        } else if (['ephemeral', 'signal', 'hello', 'command'].includes(String(head.kind))) {
          protocolError('MALFORMED', `invalid ${String(head.kind)} message`);
        } else {
          protocolError('UNKNOWN_TYPE', `unknown kind ${JSON.stringify(head.kind ?? null)}`);
        }
        return;
      }
      const msg = parsed.data as { kind: string } & Record<string, unknown>;
      if (msg.kind === 'hello') {
        if (roomReady) return;
        clearTimeout(helloTimer);
        const hello = msg as unknown as HelloMessage;
        roomId = hello.sessionId;
        roomReady = opts.rooms.get(roomId).then(
          (room) => {
            if (!room) {
              protocolError('ROOM_NOT_FOUND', `room ${JSON.stringify(hello.sessionId)} does not exist`);
              ws.close(CAMP_CLOSE.ROOM_NOT_FOUND, 'room not found');
              return null;
            }
            if (closed) return null;
            room.attach(conn, hello);
            return room;
          },
          (e) => {
            log(`room open failed: ${String(e)}`);
            ws.close(1011, 'room unavailable');
            return null;
          },
        );
        return;
      }
      if (!roomReady) {
        if (msg.kind === 'command') {
          conn.send({ camp: CAMP_VERSION, kind: 'result', commandId: msg.commandId, ok: false, reason: 'NOT_AUTHORIZED' });
        }
        protocolError('NOT_JOINED', 'send hello first');
        return;
      }
      void roomReady.then((room) => {
        if (!room) return;
        if (msg.kind === 'command') room.receiveCommand(conn, msg as unknown as CommandMessageOf<V>);
        else if (msg.kind === 'signal') room.receiveSignal?.(conn, msg as unknown as SignalMessageOf<V>);
        else room.receiveEphemeral(conn, msg as unknown as EphemeralMessageOf<V>);
      });
    });

    ws.on('close', () => {
      closed = true;
      clearInterval(beat);
      clearTimeout(helloTimer);
      void roomReady?.then((room) => {
        if (!room || !roomId) return;
        room.detach(conn);
        if (room.connectionCount === 0) opts.rooms.release(roomId);
      });
    });
  });

  return {
    wss,
    /** http サーバーの upgrade から呼ぶ */
    handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    close() {
      for (const c of wss.clients) c.terminate();
      return new Promise<void>((r) => wss.close(() => r()));
    },
  };
}
