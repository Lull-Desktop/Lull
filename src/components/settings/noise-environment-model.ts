import type { NoiseTrackEnvironment } from "@lull/media-sdk";

type Anchor = NoiseTrackEnvironment["anchors"][number];
export type DraftAnchor = Anchor & { rowId: string; percent: string };
export type EnvironmentDraft = { type: string; anchors: DraftAnchor[] };
let nextId = 0;
export function draftAnchor(anchor: Anchor): DraftAnchor {
  return {
    ...anchor,
    rowId: `anchor-${++nextId}`,
    percent: String(anchor.intensity * 100),
  };
}
export function createEnvironmentDraft(track: {
  assetId?: string;
  environment?: NoiseTrackEnvironment;
}): EnvironmentDraft {
  return {
    type: track.environment?.type ?? "rain",
    anchors: (
      track.environment?.anchors ?? [
        { assetId: track.assetId ?? "", intensity: 0 },
        { assetId: "", intensity: 1 },
      ]
    ).map(draftAnchor),
  };
}
/** Intensity is runtime state, deliberately excluded from curve conflict detection. */
export function curveKey(
  environment: NoiseTrackEnvironment | undefined,
): string {
  return environment
    ? JSON.stringify({
        type: environment.type,
        anchors: environment.anchors.map((a) => [
          a.assetId,
          a.intensity,
          a.assetHash ?? null,
          a.expectedName ?? null,
        ]),
      })
    : "none";
}
export function draftKey(draft: EnvironmentDraft): string {
  return JSON.stringify([
    draft.type,
    draft.anchors.map((a) => [
      a.assetId,
      a.percent,
      a.assetHash ?? null,
      a.expectedName ?? null,
    ]),
  ]);
}
export function percentValue(text: string): number | null {
  if (!text.trim()) return null;
  const value = Number(text);
  return Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}
export function anchorErrors(
  anchors: DraftAnchor[],
): Array<"range" | "asset" | "duplicate" | "order" | null> {
  return anchors.map((anchor, index) => {
    const value = percentValue(anchor.percent);
    if (value === null) return "range";
    if (!anchor.assetId) return "asset";
    if (anchors.some((a, i) => i !== index && a.assetId === anchor.assetId))
      return "duplicate";
    if (index > 0) {
      const previous = percentValue(anchors[index - 1].percent);
      if (previous !== null && value <= previous) return "order";
    }
    return null;
  });
}
export function serializeDraft(
  draft: EnvironmentDraft,
  intensity: number,
): NoiseTrackEnvironment {
  return {
    type: draft.type,
    intensity,
    anchors: draft.anchors.map(({ rowId: _rowId, percent, ...anchor }) => ({
      ...anchor,
      intensity: Number(percent) / 100,
    })),
  };
}
/** Insert inside the largest existing interval, preserving authored endpoints. */
export function insertAnchor(anchors: DraftAnchor[]): DraftAnchor[] {
  const sorted = [...anchors].sort(
    (a, b) => Number(a.percent) - Number(b.percent),
  );
  let index = 1;
  for (let i = 2; i < sorted.length; i++) {
    if (
      Number(sorted[i].percent) - Number(sorted[i - 1].percent) >
      Number(sorted[index].percent) - Number(sorted[index - 1].percent)
    )
      index = i;
  }
  const midpoint =
    (Number(sorted[index - 1].percent) + Number(sorted[index].percent)) / 200;
  return [
    ...sorted.slice(0, index),
    draftAnchor({ assetId: "", intensity: midpoint }),
    ...sorted.slice(index),
  ];
}
