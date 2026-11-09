/**
 * Event の順序（§4）。受け取る側は、最後に反映した seq 以下の Event を捨てる（再送・重複への備え）。
 * welcome の snapshot で取り直したら、その seq から数え直す。
 */
export class SeqGate {
  private last: number | undefined;

  get lastSeq() {
    return this.last;
  }

  /** snapshot で全体を取り直したとき */
  reset(seq: number) {
    this.last = seq;
  }

  /** この Event を反映してよいか（よければ lastSeq を進める） */
  accept(seq: number): boolean {
    if (this.last !== undefined && seq <= this.last) return false;
    this.last = seq;
    return true;
  }
}
