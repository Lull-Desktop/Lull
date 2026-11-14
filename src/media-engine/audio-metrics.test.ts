import { describe, expect, test } from "vitest";
import {
  AUDIO_ACTIVE_RMS,
  AUDIO_BAND_DB_CEIL,
  AUDIO_BAND_DB_FLOOR,
  bandDbToUnit,
  bandValuesFromDb,
  clamp01,
  isAudioActive,
  timeDomainMetrics,
} from "./audio-metrics";

const SAMPLE_RATE = 48_000;
const FFT_SIZE = 2048;
const BIN_COUNT = FFT_SIZE / 2;

function silence(): Uint8Array {
  return new Uint8Array(64).fill(128);
}

/** 全频段静音：所有 bin 都在映射下限。 */
function silentSpectrum(): Float32Array {
  return new Float32Array(BIN_COUNT).fill(AUDIO_BAND_DB_FLOOR);
}

/** 在指定频率放一个指定 dB 的 bin，其余静音。 */
function dbAt(hz: number, db: number): Float32Array {
  const data = silentSpectrum();
  const bin = Math.min(
    BIN_COUNT - 1,
    Math.round((hz / (SAMPLE_RATE / 2)) * BIN_COUNT),
  );
  data[bin] = db;
  return data;
}

describe("timeDomainMetrics", () => {
  test("静音（全 128）的 RMS 与峰值都是 0", () => {
    expect(timeDomainMetrics(silence())).toEqual({ rms: 0, peak: 0 });
  });

  test("满幅方波得到接近 1 的 rms 与 peak", () => {
    const samples = new Uint8Array(64);
    samples.forEach((_, index) => {
      samples[index] = index % 2 === 0 ? 0 : 255;
    });
    const metrics = timeDomainMetrics(samples);
    // 8bit 时域以 128 为中心：0 → -1（峰值 1），255 → 0.9921875，因此 RMS 略小于 1。
    expect(metrics.rms).toBeCloseTo(0.9961, 3);
    expect(metrics.peak).toBe(1);
  });

  test("半幅信号的 RMS 与峰值都是 0.5，不做仪表增益", () => {
    const samples = new Uint8Array(64);
    samples.forEach((_, index) => {
      samples[index] = index % 2 === 0 ? 64 : 192;
    });
    const metrics = timeDomainMetrics(samples);
    expect(metrics.rms).toBeCloseTo(0.5, 6);
    expect(metrics.peak).toBeCloseTo(0.5, 6);
  });

  test("空数组与非法数值不产生 NaN", () => {
    expect(timeDomainMetrics(new Uint8Array(0))).toEqual({ rms: 0, peak: 0 });
    expect(clamp01(Number.NaN)).toBe(0);
    expect(clamp01(Number.POSITIVE_INFINITY)).toBe(0);
    expect(clamp01(-1)).toBe(0);
    expect(clamp01(2)).toBe(1);
  });

  test("active 阈值按 RMS 判断", () => {
    expect(isAudioActive(0)).toBe(false);
    expect(isAudioActive(AUDIO_ACTIVE_RMS)).toBe(false);
    expect(isAudioActive(AUDIO_ACTIVE_RMS + 0.0001)).toBe(true);
  });
});

describe("bandDbToUnit", () => {
  test("按 dB 线性映射，而不是按线性幅度", () => {
    expect(bandDbToUnit(AUDIO_BAND_DB_FLOOR)).toBe(0);
    expect(bandDbToUnit(AUDIO_BAND_DB_CEIL)).toBe(1);
    // -38 dB 恰好落在 -70…-6 的中点。
    expect(bandDbToUnit(-38)).toBeCloseTo(0.5, 6);
    expect(bandDbToUnit(-20)).toBeCloseTo(50 / 64, 6);
  });

  test("下限以下与非法值都归零", () => {
    expect(bandDbToUnit(-120)).toBe(0);
    expect(bandDbToUnit(Number.NEGATIVE_INFINITY)).toBe(0);
    expect(bandDbToUnit(Number.NaN)).toBe(0);
    expect(bandDbToUnit(0)).toBe(1);
  });
});

describe("bandValuesFromDb", () => {
  test("100Hz 只落在 bass", () => {
    const bands = bandValuesFromDb(dbAt(100, -10), SAMPLE_RATE, FFT_SIZE);
    expect(bands.bass).toBeGreaterThan(0);
    expect(bands.lowMid).toBe(0);
    expect(bands.mid).toBe(0);
    expect(bands.highMid).toBe(0);
    expect(bands.treble).toBe(0);
  });

  test("1kHz 只落在 mid", () => {
    const bands = bandValuesFromDb(dbAt(1000, -10), SAMPLE_RATE, FFT_SIZE);
    expect(bands.mid).toBeGreaterThan(0);
    expect(bands.bass).toBe(0);
    expect(bands.treble).toBe(0);
  });

  test("8kHz 只落在 treble", () => {
    const bands = bandValuesFromDb(dbAt(8000, -10), SAMPLE_RATE, FFT_SIZE);
    expect(bands.treble).toBeGreaterThan(0);
    expect(bands.bass).toBe(0);
    expect(bands.mid).toBe(0);
  });

  test("能量平均后 dB 越低柱越低，且保持对数刻度", () => {
    const loud = bandValuesFromDb(dbAt(100, -10), SAMPLE_RATE, FFT_SIZE).bass;
    const quiet = bandValuesFromDb(dbAt(100, -40), SAMPLE_RATE, FFT_SIZE).bass;
    expect(loud).toBeGreaterThan(quiet);
    // 30 dB 的差 ≈ 30/64 = 0.469 个视觉单位（底部 bin 会带来极小偏差）。
    expect(loud - quiet).toBeCloseTo(30 / 64, 2);
    expect(quiet).toBeGreaterThan(0.3);
  });

  test("全频段 -6 dBFS 时每段都接近 1", () => {
    const data = new Float32Array(BIN_COUNT).fill(-6);
    const bands = bandValuesFromDb(data, SAMPLE_RATE, FFT_SIZE);
    for (const value of Object.values(bands)) {
      expect(value).toBeCloseTo(1, 6);
    }
  });

  test("静音、空频域与非法采样率都返回 0，不越界", () => {
    for (const value of Object.values(
      bandValuesFromDb(silentSpectrum(), SAMPLE_RATE, FFT_SIZE),
    )) {
      expect(value).toBe(0);
    }
    expect(
      bandValuesFromDb(new Float32Array(0), SAMPLE_RATE, FFT_SIZE).bass,
    ).toBe(0);
    const bands = bandValuesFromDb(
      new Float32Array(BIN_COUNT).fill(Number.NEGATIVE_INFINITY),
      8000,
      FFT_SIZE,
    );
    for (const value of Object.values(bands)) {
      expect(value).toBe(0);
    }
  });

  test("输出永远在 0–1", () => {
    const bands = bandValuesFromDb(
      new Float32Array(BIN_COUNT).fill(0),
      SAMPLE_RATE,
      FFT_SIZE,
    );
    for (const value of Object.values(bands)) {
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(1);
    }
  });
});
