/**
 * 起動：npx tsx packages/camp/examples/quick-vote/server.ts
 * 別の端末で：npx tsx packages/camp/examples/quick-vote/demo.ts
 */
import { createCampServer } from '@camp-protocol/kit/server';
import { pollRoom } from './room.ts';
import { quickVote } from './vocabulary.ts';

const server = createCampServer(quickVote, { port: Number(process.env.PORT ?? 8790), room: pollRoom() });
console.log(`Quick Vote: ws://localhost:${await server.port}/camp`);
