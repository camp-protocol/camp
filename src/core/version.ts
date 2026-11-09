/**
 * CAMP の核（core）：どのアプリの言葉も知らない、プロトコルそのものの部分（ADR-0010 §5）。
 * このフォルダは ../vocabulary を import しない（test/boundary.test.ts で検査する）。
 */

export const CAMP_VERSION = '1';
/** このサーバー・クライアントが話せる CAMP のメジャー版 */
export const SUPPORTED_CAMP_VERSIONS = [CAMP_VERSION] as const;

/** WebSocket の終了コード（docs/protocol/camp-v1.md §11） */
export const CAMP_CLOSE = {
  UNSUPPORTED_VERSION: 4400,
  /** 部屋がない（アプリが作っていない・期限切れ）。再接続しない */
  ROOM_NOT_FOUND: 4404,
  HELLO_TIMEOUT: 4408,
  RATE_LIMITED: 4429,
} as const;
