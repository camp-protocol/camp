import { randomInt } from 'node:crypto';

const LETTERS = 'abcdefghijklmnopqrstuvwxyz';

/**
 * 推測されにくい部屋 ID（例 "kqd-rmzw-tbe"、Google Meet のリンクと同じ形）。
 * 26^10 ≒ 1.4×10^14 通りあるので、リンクを知っている人だけが入れる、という使い方ができる。
 */
export function randomRoomId(): string {
  const pick = (n: number) => Array.from({ length: n }, () => LETTERS[randomInt(LETTERS.length)]).join('');
  return `${pick(3)}-${pick(4)}-${pick(3)}`;
}

/** randomRoomId() の形か（URL から来た値を、部屋を探す前にふるい分ける） */
export function isRoomId(value: string): boolean {
  return /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/.test(value);
}
