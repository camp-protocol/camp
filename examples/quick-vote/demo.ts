/**
 * 3人が同じ部屋に入り、ホストが質問を出し、全員がほぼ同時に投票し、締め切ってまとめを受け取る。
 * 実行：npx tsx packages/camp/examples/quick-vote/demo.ts （先に server.ts を起動しておく）
 */
import WebSocket from 'ws';
import { CampClient, type WebSocketLike } from '@camp-protocol/kit/client';
import { quickVote } from './vocabulary.ts';

const url = process.env.CAMP_URL ?? 'ws://localhost:8790/camp';
const join = (name: string) =>
  new Promise<CampClient<typeof quickVote>>((resolve) => {
    const c = new CampClient(quickVote, { url, room: 'demo', createSocket: (u) => new WebSocket(u) as unknown as WebSocketLike });
    c.on({
      onWelcome: () => resolve(c),
      onEvent: (e) => console.log(`[${name}] #${e.seq} ${e.type} votes=${JSON.stringify(e.snapshot.votes)}${e.snapshot.summary ? ` summary=${e.snapshot.summary}` : ''}`),
    }).connect();
  });

const [host, a, b] = [await join('host'), await join('A'), await join('B')];
console.log('open:', await host.send('OPEN_POLL', { question: '打ち上げは何にする？', options: ['焼肉', 'カレー'] }));
console.log('votes:', await Promise.all([host.send('VOTE', { option: 0 }), a.send('VOTE', { option: 1 }), b.send('VOTE', { option: 1 })]));
console.log('A votes again:', await a.send('VOTE', { option: 0 })); // → ALREADY_VOTED
console.log('B tries to close:', await b.send('CLOSE_POLL', {})); // → NOT_HOST
console.log('close:', await host.send('CLOSE_POLL', {}));
setTimeout(() => {
  for (const c of [host, a, b]) c.close();
}, 800);
