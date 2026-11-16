import { describe, expect, test } from "vitest";
import {
  anchorErrors,
  draftAnchor,
  insertAnchor,
  percentValue,
  serializeDraft,
} from "./noise-environment-model";

describe("environment authoring model", () => {
  test("preserves precision and reference metadata without persisting UI identities", () => {
    const anchor = draftAnchor({
      assetId: "a",
      intensity: 0.1234567,
      assetHash: "hash",
      expectedName: "name",
    });
    expect(
      serializeDraft({ type: "insects", anchors: [anchor] }, 0.8).anchors[0],
    ).toEqual({
      assetId: "a",
      intensity: 0.1234567,
      assetHash: "hash",
      expectedName: "name",
    });
    expect(percentValue("")).toBeNull();
    expect(percentValue("101")).toBeNull();
    expect(percentValue("NaN")).toBeNull();
    expect(percentValue("-1")).toBeNull();
  });
  test("inserts inside largest authored interval and retains existing row identities", () => {
    const anchors = [
      draftAnchor({ assetId: "a", intensity: 0.1 }),
      draftAnchor({ assetId: "b", intensity: 0.3 }),
      draftAnchor({ assetId: "c", intensity: 0.9 }),
    ];
    const result = insertAnchor(anchors);
    expect(result.map((a) => Number(a.percent))).toEqual([10, 30, 60, 90]);
    expect(result[3].rowId).toBe(anchors[2].rowId);
    expect(anchorErrors(result)).toEqual([null, null, "asset", null]);
  });
});
