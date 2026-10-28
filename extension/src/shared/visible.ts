// 見えている欄の判定の部品(純粋な関数)。DOM に触る側は content/fields.ts。
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface DocSize {
  scrollWidth: number;
  scrollHeight: number;
}

/** 大きさが 1px 未満(幅か高さが 0 を含む)の欄は見えないものとする。 */
export function isTooSmall(box: Box): boolean {
  return box.right - box.left < 1 || box.bottom - box.top < 1;
}

/** 文書の範囲(左上が原点、scrollWidth x scrollHeight)の外にあるか。box は文書の座標。 */
export function isOutsideDocument(box: Box, doc: DocSize): boolean {
  return box.right <= 0 || box.bottom <= 0 || box.left >= doc.scrollWidth || box.top >= doc.scrollHeight;
}

/** 2つの箱が重なる面積があるか。 */
export function intersects(a: Box, b: Box): boolean {
  return Math.min(a.right, b.right) - Math.max(a.left, b.left) > 0
    && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 0;
}
