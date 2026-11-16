/** A semantic intensity anchor, independent of track volume and audio meters. */
export type IntensityAnchor = { assetId: string; intensity: number };

/** Validate the authored curve before it is handed to the playback engine. */
export function validateIntensityAnchors(anchors: readonly IntensityAnchor[]): boolean {
  if (anchors.length < 2 || anchors.length > 8) return false;
  const assets = new Set<string>();
  let previous = -1;
  for (const anchor of anchors) {
    if (
      !anchor.assetId ||
      assets.has(anchor.assetId) ||
      !Number.isFinite(anchor.intensity) ||
      anchor.intensity < 0 ||
      anchor.intensity > 1 ||
      anchor.intensity <= previous
    ) return false;
    assets.add(anchor.assetId);
    previous = anchor.intensity;
  }
  return true;
}

/** Linear interpolation keeps the combined gain constant between adjacent anchors. */
export function intensityWeights(
  anchors: readonly IntensityAnchor[],
  intensity: number,
): number[] {
  const weights = anchors.map(() => 0);
  if (!validateIntensityAnchors(anchors)) return weights;
  const value = Number.isFinite(intensity) ? Math.max(0, Math.min(1, intensity)) : 0;
  if (value <= anchors[0].intensity) {
    weights[0] = 1;
    return weights;
  }
  for (let index = 1; index < anchors.length; index += 1) {
    const left = anchors[index - 1];
    const right = anchors[index];
    if (value <= right.intensity) {
      const fraction = (value - left.intensity) / (right.intensity - left.intensity);
      weights[index - 1] = 1 - fraction;
      weights[index] = fraction;
      return weights;
    }
  }
  weights[weights.length - 1] = 1;
  return weights;
}
