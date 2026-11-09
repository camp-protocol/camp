import type { RoomDefinition } from '@camp-protocol/kit/server';
import type { quickVote } from './vocabulary.ts';

export interface PollState {
  status: 'idle' | 'open' | 'closed';
  question: string;
  options: string[];
  votes: Record<string, number>;
  summary: string | null;
  hmm: number;
}

/** 遅い AI の代わり。実際のアプリならここで Gemini などを呼ぶ */
export type Summarize = (question: string, tally: number[]) => Promise<string>;

export const fakeSummarize: Summarize = async (question, tally) => {
  await new Promise((r) => setTimeout(r, 300));
  return `「${question}」は ${tally.join(' 対 ')} でした`;
};

/** 部屋のルール。開発者が書くのは「通すか・断るか・何が起きたか」だけ */
export function pollRoom(summarize: Summarize = fakeSummarize): RoomDefinition<typeof quickVote, PollState> {
  return {
    initialState: () => ({ status: 'idle', question: '', options: [], votes: {}, summary: null, hmm: 0 }),
    maxParticipants: 5,
    commands: {
      OPEN_POLL(room, { question, options }, { actor }) {
        if (!room.isHost(actor)) return room.reject('NOT_HOST');
        // 前の投票の「AI のまとめ」が遅れて届いても、新しい投票には混ぜない
        room.reset({ status: 'open', question, options, votes: {}, summary: null, hmm: 0 });
        room.emit('POLL_OPENED', { question });
      },
      VOTE(room, { option }, { actor }) {
        const s = room.state;
        if (s.status !== 'open') return room.reject('POLL_NOT_OPEN');
        if (option >= s.options.length) return room.reject('NO_SUCH_OPTION');
        if (actor in s.votes) return room.reject('ALREADY_VOTED');
        s.votes[actor] = option;
        room.emit('VOTED', { by: actor });
      },
      CLOSE_POLL(room, _payload, { actor }) {
        if (!room.isHost(actor)) return room.reject('NOT_HOST');
        if (room.state.status !== 'open') return room.reject('POLL_NOT_OPEN');
        room.state.status = 'closed';
        room.emit('POLL_CLOSED', {});
        const tally = room.state.options.map((_, i) => Object.values(room.state.votes).filter((v) => v === i).length);
        room.task(
          () => summarize(room.state.question, tally),
          (summary) => {
            room.state.summary = summary;
            room.emit('SUMMARY_READY', {});
          },
        );
      },
    },
    signals: {
      HMM(room) {
        room.state.hmm++;
        room.emit('HMM_COUNTED', { hmm: room.state.hmm });
      },
    },
  };
}
