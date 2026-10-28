import { describe, expect, it } from "vitest";
import { intersects, isOutsideDocument, isTooSmall } from "../src/shared/visible.ts";

const box = (left: number, top: number, right: number, bottom: number) => ({ left, top, right, bottom });
const doc = { scrollWidth: 1000, scrollHeight: 800 };

describe("見える欄の判定の部品", () => {
  it("大きさ 0 と 1px 未満は小さすぎる", () => {
    expect(isTooSmall(box(10, 10, 10, 30))).toBe(true);
    expect(isTooSmall(box(10, 10, 110, 10))).toBe(true);
    expect(isTooSmall(box(10, 10, 10.5, 30))).toBe(true);
    expect(isTooSmall(box(10, 10, 110, 40))).toBe(false);
  });

  it("文書の範囲の外", () => {
    expect(isOutsideDocument(box(-9999, 10, -9799, 40), doc)).toBe(true);
    expect(isOutsideDocument(box(10, -9999, 210, -9969), doc)).toBe(true);
    expect(isOutsideDocument(box(1000, 10, 1200, 40), doc)).toBe(true);
    expect(isOutsideDocument(box(10, 800, 210, 830), doc)).toBe(true);
    expect(isOutsideDocument(box(10, 10, 210, 40), doc)).toBe(false);
    expect(isOutsideDocument(box(-50, 10, 50, 40), doc)).toBe(false);
  });

  it("重なり", () => {
    expect(intersects(box(0, 0, 10, 10), box(5, 5, 20, 20))).toBe(true);
    expect(intersects(box(0, 0, 10, 10), box(10, 0, 20, 10))).toBe(false);
    expect(intersects(box(0, 0, 10, 10), box(0, 20, 0, 20))).toBe(false);
  });
});
