export {
  type IntensityAnchor,
  intensityWeights,
  validateIntensityAnchors,
} from "@/lib/environment-intensity";

/** Rain detail density grows independently of the track's output volume. */
export function rainDetailParameters(intensity: number): {
  rate: number;
  gain: number;
} {
  const value = Number.isFinite(intensity)
    ? Math.max(0, Math.min(1, intensity))
    : 0;
  return { rate: 0.5 + value * 2.5, gain: 0.12 + value * 0.24 };
}
