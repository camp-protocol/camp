import { randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * つなぎ直し用の合言葉（§7・§12）。参加者 ID は snapshot でほかの人にも見えるので、
 * それだけで「同じ人として戻る」を許すと、部屋のリンクを知っている人なら誰にでもなりすませてしまう。
 * welcome で本人にだけ合言葉を渡し、hello で同じ合言葉が返ってきたときだけ同じ参加者に戻す。
 */
export function createResumeToken(): string {
  return randomBytes(24).toString('base64url');
}

/** 合言葉が一致するか（時間差で中身を推測されないよう、長さをそろえて比べる） */
export function resumeTokenMatches(expected: string | undefined, given: string | undefined): boolean {
  if (!expected || !given) return false;
  const a = Buffer.from(expected);
  const b = Buffer.from(given);
  return a.length === b.length && timingSafeEqual(a, b);
}
