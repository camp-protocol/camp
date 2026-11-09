/**
 * 二重処理の防止（§5.2）。(送り手, commandId) ごとに結果を覚え、同じ組が来たら同じ結果を返す。
 * 古いものから捨てる（挿入順の Map を使った簡易 LRU）。
 */
export class ResultCache<R> {
  private map = new Map<string, R>();

  constructor(private readonly limit = 500) {}

  private key(senderId: string, commandId: string) {
    return `${senderId}:${commandId}`;
  }

  get(senderId: string, commandId: string): R | undefined {
    return this.map.get(this.key(senderId, commandId));
  }

  set(senderId: string, commandId: string, result: R) {
    this.map.set(this.key(senderId, commandId), result);
    if (this.map.size > this.limit) this.map.delete(this.map.keys().next().value!);
  }

  get size() {
    return this.map.size;
  }
}
