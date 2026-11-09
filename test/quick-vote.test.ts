/**
 * @camp-protocol/kit を IDEA AUDITION 以外のアプリ（examples/quick-vote）で使い、プロトコルの約束を確かめる。
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import WebSocket from 'ws';
import { CAMP_CLOSE, CAMP_VERSION } from '../src/core/index.ts';
import { CampClient, type WebSocketLike } from '../src/client/index.ts';
import { createCampServer, isRoomId } from '../src/server/index.ts';
import { pollRoom, type Summarize } from '../examples/quick-vote/room.ts';
import { quickVote } from '../examples/quick-vote/vocabulary.ts';

let release: (() => void) | null = null;
/** 締め切りのたびに呼ばれる「AI のまとめ」。テストから止めたり進めたりできる */
const summarize: Summarize = (q, tally) =>
  new Promise((r) => {
    release = () => r(`${q}:${tally.join('-')}`);
  });

let server: ReturnType<typeof createCampServer<typeof quickVote, unknown>>;
let url = '';
beforeAll(async () => {
  server = createCampServer(quickVote, { port: 0, room: pollRoom(summarize), helloTimeoutMs: 300 }) as never;
  url = `ws://127.0.0.1:${await server.port}/camp`;
});
afterAll(() => server.close());

type Client = CampClient<typeof quickVote> & { socket: () => WebSocket; snap: () => Snap | null; events: string[] };
type Snap = Parameters<NonNullable<Parameters<CampClient<typeof quickVote>['on']>[0]['onSnapshot']>>[0];

let roomNo = 0;
function join(room: string, participantId?: string): Promise<Client> {
  return new Promise((resolve) => {
    let ws: WebSocket;
    let snap: Snap | null = null;
    const events: string[] = [];
    const c = new CampClient(quickVote, {
      url,
      room,
      ...(participantId ? { participantId } : {}),
      createSocket: (u) => (ws = new WebSocket(u)) as unknown as WebSocketLike,
      maxBackoffMs: 50,
    }) as Client;
    c.socket = () => ws;
    c.snap = () => snap;
    c.events = events;
    c.on({
      onSnapshot: (s) => (snap = s),
      onEvent: (e) => events.push(`${e.seq}:${e.type}`),
      onWelcome: () => resolve(c),
    }).connect();
  });
}
const until = async (cond: () => boolean, ms = 2000) => {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error('timeout');
    await new Promise((r) => setTimeout(r, 10));
  }
};

async function openRoom(n: number) {
  const room = `qv-${++roomNo}`;
  const clients: Client[] = [];
  for (let i = 0; i < n; i++) clients.push(await join(room));
  expect(await clients[0]!.send('OPEN_POLL', { question: '打ち上げ', options: ['焼肉', 'カレー', '寿司'] })).toEqual({ ok: true });
  await until(() => clients.every((c) => c.snap()?.status === 'open'));
  return { room, clients };
}

describe('@camp-protocol/kit × Quick Vote', () => {
  it('同時に投票しても、全員が同じ順番で同じ状態を受け取る', async () => {
    const { clients } = await openRoom(4);
    const results = await Promise.all(clients.map((c, i) => c.send('VOTE', { option: i % 3 })));
    expect(results.every((r) => r.ok)).toBe(true);
    await until(() => clients.every((c) => Object.keys(c.snap()!.votes).length === 4));
    const orders = clients.map((c) => c.events.join(','));
    expect(new Set(orders).size).toBe(1); // 4人とも同じ連番・同じ順番
    expect(new Set(clients.map((c) => JSON.stringify(c.snap())))).toHaveProperty('size', 1);
  });

  it('ルールに合わない操作は、状態を変えずに理由を返す', async () => {
    const { clients } = await openRoom(2);
    const [host, guest] = clients as [Client, Client];
    expect(await guest.send('VOTE', { option: 9 })).toEqual({ ok: false, reason: 'NO_SUCH_OPTION' });
    expect(await guest.send('VOTE', { option: 1 })).toEqual({ ok: true });
    expect(await guest.send('VOTE', { option: 0 })).toEqual({ ok: false, reason: 'ALREADY_VOTED' });
    expect(await guest.send('CLOSE_POLL', {})).toEqual({ ok: false, reason: 'NOT_HOST' });
    expect(host.snap()!.status).toBe('open');
  });

  it('同じ commandId の再送は1回しか実行しない', async () => {
    const { room, clients } = await openRoom(1);
    const raw = new WebSocket(url);
    const got: { kind: string; type?: string; commandId?: string }[] = [];
    raw.on('message', (d) => got.push(JSON.parse(d.toString())));
    await new Promise((r) => raw.on('open', r));
    raw.send(JSON.stringify({ camp: CAMP_VERSION, kind: 'hello', sessionId: room }));
    await until(() => got.some((m) => m.kind === 'welcome'));
    const vote = { camp: CAMP_VERSION, kind: 'command', type: 'VOTE', commandId: 'same', sentAt: '', payload: { option: 2 } };
    for (let i = 0; i < 3; i++) raw.send(JSON.stringify(vote));
    await until(() => got.filter((m) => m.kind === 'result').length === 3);
    const results = got.filter((m) => m.kind === 'result');
    expect(new Set(results.map((r) => JSON.stringify(r))).size).toBe(1);
    expect(got.filter((m) => m.kind === 'event' && m.type === 'VOTED')).toHaveLength(1);
    expect(Object.keys(clients[0]!.snap()!.votes)).toHaveLength(1);
    raw.close();
  });

  it('切断しても自動で再接続し、同じ参加者として最新の状態に追いつく', async () => {
    const { clients } = await openRoom(2);
    const [host, guest] = clients as [Client, Client];
    const id = guest.id;
    guest.socket().terminate();
    await host.send('VOTE', { option: 0 }); // 切断中に起きた変化
    await until(() => guest.snap()?.votes[host.id!] === 0);
    expect(guest.id).toBe(id);
    expect(await guest.send('VOTE', { option: 1 })).toEqual({ ok: true });
  });

  it('参加者 ID だけでは他人として戻れない（welcome で本人にだけ渡す合言葉が要る）', async () => {
    const { room, clients } = await openRoom(2);
    const [host, guest] = clients as [Client, Client];
    expect(host.resumeToken).toBeTruthy();
    expect(host.resumeToken).not.toBe(guest.resumeToken);
    // host の ID は snapshot で全員に見えている。それを名乗って入っても、合言葉が無ければ別の参加者になる
    const impostor = await join(room, host.id!);
    expect(impostor.id).not.toBe(host.id);
    expect(impostor.snap()!.participants.find((p: { id: string; isHost: boolean }) => p.id === host.id)?.isHost).toBe(true);
    // 合言葉を渡せば、ページを開き直しても同じ人として戻れる
    const back = await new Promise<Client>((resolve) => {
      const c = new CampClient(quickVote, {
        url,
        room,
        participantId: guest.id!,
        resumeToken: guest.resumeToken!,
        createSocket: (u) => new WebSocket(u) as unknown as WebSocketLike,
      }) as Client;
      c.on({ onWelcome: () => resolve(c) }).connect();
    });
    expect(back.id).toBe(guest.id);
  });

  it('遅い処理の結果を反映する処理が例外を出しても、サーバーは止まらない', async () => {
    const { createCampServer: create } = await import('../src/server/index.ts');
    const errors: unknown[] = [];
    const original = console.error;
    console.error = (...a: unknown[]) => void errors.push(a);
    const s = create(quickVote, {
      port: 0,
      room: {
        initialState: () => ({ n: 0 }),
        commands: {
          OPEN_POLL(r) {
            r.task(
              async () => 1,
              () => {
                throw new Error('boom');
              },
            );
          },
        },
        snapshot: (_s, info) =>
          ({ seq: info.seq, status: 'idle', question: '', options: [], votes: {}, summary: null, hmm: 0, participants: info.participants }) as never,
      },
    }) as never as ReturnType<typeof createCampServer<typeof quickVote, unknown>>;
    const port = await s.port;
    const c = new CampClient(quickVote, { url: `ws://127.0.0.1:${port}/camp`, room: 'boom', createSocket: (u) => new WebSocket(u) as unknown as WebSocketLike });
    await new Promise<void>((r) => c.on({ onWelcome: () => r() }).connect());
    expect(await c.send('OPEN_POLL', { question: 'q', options: ['a', 'b'] })).toEqual({ ok: true });
    await until(() => errors.length > 0);
    console.error = original;
    c.close();
    await s.close();
  });

  it('部屋の数に上限があり、超えたら新しい部屋は作らない', async () => {
    const s = createCampServer(quickVote, { port: 0, room: pollRoom(summarize), maxRooms: 1 }) as never as ReturnType<typeof createCampServer<typeof quickVote, unknown>>;
    s.createRoom('one-room-ok');
    expect(() => s.createRoom()).toThrow(/room limit/);
    s.close();
  });

  it('遅い処理（AI のまとめ）は、作り直したあとに届いても新しい投票に混ざらない', async () => {
    const { clients } = await openRoom(1);
    const host = clients[0]!;
    await host.send('VOTE', { option: 0 });
    await host.send('CLOSE_POLL', {});
    const late = release!;
    await host.send('OPEN_POLL', { question: '次の質問', options: ['A', 'B'] }); // まとめを待たずに次へ
    late();
    await new Promise((r) => setTimeout(r, 50));
    expect(host.snap()!.question).toBe('次の質問');
    expect(host.snap()!.summary).toBeNull();
    // 次の締め切りのまとめは普通に届く
    await host.send('CLOSE_POLL', {});
    release!();
    await until(() => host.snap()!.summary === '次の質問:0-0');
  });

  it('定員を超えた人は観覧になり、操作は SPECTATOR で断られる', async () => {
    const { room } = await openRoom(5);
    const sixth = await join(room);
    expect(sixth.id).toBeNull();
    expect(await sixth.send('VOTE', { option: 0 })).toEqual({ ok: false, reason: 'SPECTATOR' });
  });

  it('Signal は返事なしで、1人1秒2件までに間引かれる', async () => {
    const { clients } = await openRoom(1);
    const host = clients[0]!;
    for (let i = 0; i < 10; i++) host.signal('HMM', {});
    await new Promise((r) => setTimeout(r, 100));
    expect(host.snap()!.hmm).toBe(2);
  });

  it('知らない Command は UNKNOWN_TYPE、違う版の hello は 4400 で切断', async () => {
    const raw = new WebSocket(url);
    const got: { kind: string; reason?: string; code?: string }[] = [];
    raw.on('message', (d) => got.push(JSON.parse(d.toString())));
    await new Promise((r) => raw.on('open', r));
    raw.send(JSON.stringify({ camp: CAMP_VERSION, kind: 'hello', sessionId: `qv-${++roomNo}` }));
    await until(() => got.some((m) => m.kind === 'welcome'));
    raw.send(JSON.stringify({ camp: CAMP_VERSION, kind: 'command', type: 'TELEPORT', commandId: 'x', sentAt: '', payload: {} }));
    await until(() => got.some((m) => m.kind === 'result'));
    expect(got.find((m) => m.kind === 'result')).toMatchObject({ ok: false, reason: 'UNKNOWN_TYPE' });
    raw.close();

    const old = new WebSocket(url);
    const closed = new Promise<number>((r) => old.on('close', (code) => r(code)));
    await new Promise((r) => old.on('open', r));
    old.send(JSON.stringify({ camp: '2', kind: 'hello', sessionId: 'x' }));
    expect(await closed).toBe(CAMP_CLOSE.UNSUPPORTED_VERSION);
  });

  it('close() 中に切れた部屋は片付けられ、プロセスを引き止めるタイマーを残さない', async () => {
    const own = createCampServer(quickVote, { port: 0, room: pollRoom(summarize) });
    const ownUrl = `ws://127.0.0.1:${await own.port}/camp`;
    const ws = new WebSocket(ownUrl);
    await new Promise((r) => ws.on('open', r));
    ws.send(JSON.stringify({ camp: CAMP_VERSION, kind: 'hello', sessionId: 'closing' }));
    await until(() => !!own.rooms.get('closing'));
    await own.close();
    await until(() => !own.rooms.get('closing'));
  });

  it('autoCreateRooms: false なら、作った部屋のリンクでだけ入れる。知らない部屋は ROOM_NOT_FOUND で再接続しない', async () => {
    const own = createCampServer(quickVote, { port: 0, room: pollRoom(summarize), autoCreateRooms: false });
    const ownUrl = `ws://127.0.0.1:${await own.port}/camp`;
    const id = own.createRoom();
    expect(isRoomId(id)).toBe(true);

    const states: string[] = [];
    let notFound = 0;
    const lost = new CampClient(quickVote, {
      url: ownUrl,
      room: 'abc-defg-hij',
      createSocket: (u) => new WebSocket(u) as unknown as WebSocketLike,
      maxBackoffMs: 20,
    })
      .on({ onState: (s) => states.push(s), onRoomNotFound: () => notFound++ })
      .connect();
    await until(() => states.includes('closed'));
    await new Promise((r) => setTimeout(r, 100));
    expect(notFound).toBe(1);
    expect(states.filter((s) => s === 'reconnecting')).toEqual([]);
    lost.close();

    let joined = false;
    const ok = new CampClient(quickVote, { url: ownUrl, room: id, createSocket: (u) => new WebSocket(u) as unknown as WebSocketLike })
      .on({ onWelcome: () => (joined = true) })
      .connect();
    await until(() => joined);
    ok.close();
    await own.close();
  });

  it('決めたパス以外への接続は、何も返さずに切らず HTTP 404 で断る（前段にサーバーを入れ替えさせない）', async () => {
    const status = await new Promise<number>((resolve) => {
      const ws = new WebSocket(url.replace('/camp', '/elsewhere'));
      ws.on('unexpected-response', (_req, res) => resolve(res.statusCode ?? 0));
      ws.on('error', () => {});
    });
    expect(status).toBe(404);
  });
});
