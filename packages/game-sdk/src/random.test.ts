import { describe, expect, test } from "vitest";
import { createSeededRandom } from "./random.js";

describe("确定性随机源", () => {
  test("同一 seed 产生同一序列", () => {
    const first = createSeededRandom(42);
    const second = createSeededRandom(42);
    const a = Array.from({ length: 8 }, () => first());
    const b = Array.from({ length: 8 }, () => second());
    expect(a).toEqual(b);
  });

  test("输出落在 [0, 1)", () => {
    const random = createSeededRandom(7);
    for (let index = 0; index < 500; index += 1) {
      const value = random();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
    }
  });

  test("不同 seed 的序列不同，且 seed 会被转成 32 位", () => {
    const a = createSeededRandom(1);
    const b = createSeededRandom(2);
    const sequenceA = Array.from({ length: 4 }, () => a());
    const sequenceB = Array.from({ length: 4 }, () => b());
    expect(sequenceA).not.toEqual(sequenceB);

    const wrapped = createSeededRandom(-1);
    const unsigned = createSeededRandom(0xffff_ffff);
    expect(Array.from({ length: 4 }, () => wrapped())).toEqual(
      Array.from({ length: 4 }, () => unsigned()),
    );
  });

  test("同一个生成器连续调用会推进状态", () => {
    const random = createSeededRandom(99);
    expect(random()).not.toBe(random());
  });
});
