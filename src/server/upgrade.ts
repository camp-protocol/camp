import type { Duplex } from 'node:stream';

/**
 * WebSocket にしない upgrade 要求（知らないパスなど）を、HTTP の応答をきちんと返して断る。
 * 何も返さずに socket.destroy() すると、Cloud Run などの前段は「壊れた応答」とみなし、
 * コンテナごと入れ替えることがある（1件の変な要求でサーバー全体が再起動する）。
 */
export function rejectUpgrade(socket: Duplex, status = 404, reason = 'Not Found') {
  if (socket.destroyed) return;
  socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${reason.length}\r\n\r\n${reason}`);
}
