import { expect, test } from "vitest";
import { syncedDelayMs } from "./sync";

test("syncedDelayMs is deterministic negative phase", () => {
  expect(syncedDelayMs(13000, 0)).toBe(0);
  expect(syncedDelayMs(13000, 1234)).toBe(-1234);
  expect(syncedDelayMs(13000, 26000)).toBe(0);
  expect(syncedDelayMs(13000, 26001)).toBe(-1);
});

test("invalid period falls back to zero delay", () => {
  expect(syncedDelayMs(0, 1234)).toBe(0);
  expect(syncedDelayMs(Number.NaN, 1234)).toBe(0);
});
