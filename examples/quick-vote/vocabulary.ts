import { z } from 'zod';
import { defineVocabulary } from '@camp-protocol/kit';

/**
 * 例：みんなで投票（Quick Vote）。IDEA AUDITION とは関係のない、最小の CAMP アプリ。
 * ホストが質問を出し、参加者が投票し、ホストが締め切ると「AI のまとめ」（遅い処理の代わり）が届く。
 */
export const quickVote = defineVocabulary({
  commands: {
    OPEN_POLL: z.object({ question: z.string().min(1).max(100), options: z.array(z.string().min(1)).min(2).max(6) }),
    VOTE: z.object({ option: z.number().int().min(0) }),
    CLOSE_POLL: z.object({}),
  },
  events: ['POLL_OPENED', 'VOTED', 'POLL_CLOSED', 'SUMMARY_READY', 'HMM_COUNTED'],
  rejectReasons: ['NOT_HOST', 'POLL_NOT_OPEN', 'ALREADY_VOTED', 'NO_SUCH_OPTION'],
  snapshot: z.object({
    seq: z.number().int(),
    status: z.enum(['idle', 'open', 'closed']),
    question: z.string(),
    options: z.array(z.string()),
    votes: z.record(z.string(), z.number()),
    summary: z.string().nullable(),
    hmm: z.number().int(),
    participants: z.array(z.object({ id: z.string(), connected: z.boolean(), isHost: z.boolean(), joinedAt: z.number() })),
  }),
  ephemerals: {
    CURSOR: z.object({ x: z.number().min(0).max(1), y: z.number().min(0).max(1) }),
  },
  signals: {
    /** 「うーん」：返事のいらない曖昧な反応 */
    HMM: z.object({}),
  },
});
