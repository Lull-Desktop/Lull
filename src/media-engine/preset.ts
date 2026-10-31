/** 与 Rust catalog.json 的 ambient 预设一致；只读。 */
export type AmbientPreset = {
  bpm: number;
  chords: readonly (readonly number[])[];
  melody: readonly number[];
  wave: "sine" | "triangle";
  brightness: number;
  air: number;
  seed: number;
};
