/**
 * Music 与 Noise 唯一的 AudioGraph。
 *
 * 一个 AudioContext、两条业务总线、一个 master 与 limiter：
 *
 *   musicBus ─ musicAnalyser ─┐
 *                             ├─ mix ─ mixAnalyser ─ master ─ masterAnalyser ─ limiter ─ destination
 *   noiseBus ─ noiseAnalyser ─┘
 *
 * 业务层只设置音量/静音，不直接连接 destination；设备切换由 host 重载引擎后
 * 由 Rust 全量 resync。
 *
 * 四个 AnalyserNode 都是 pass-through：只读信号，不改变音质与增益语义。
 * music/noise 分析点位于各自总线音量之后；mix 位于两总线汇合、master 音量之前；
 * master 位于 master 音量之后、limiter 之前。
 */
import type { AudioBands, AudioSource } from "@/sdk/scene";
import {
  bandValuesFromDb,
  isAudioActive,
  timeDomainMetrics,
} from "./audio-metrics";
import { busGain, clamp01, noiseBusGain, outputGain } from "./gain";

type BrowserAudioContext = typeof AudioContext;

function resolveAudioContextCtor(): BrowserAudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: BrowserAudioContext })
      .webkitAudioContext ??
    null
  );
}

function rampParam(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, 0.05);
}

function rmsLevel(
  analyser: AnalyserNode | null,
  samples: Uint8Array<ArrayBuffer> | null,
): { level: number; samples: Uint8Array<ArrayBuffer> | null } {
  if (!analyser) return { level: 0, samples };
  const next =
    samples && samples.length === analyser.fftSize
      ? samples
      : new Uint8Array(analyser.fftSize);
  analyser.getByteTimeDomainData(next);
  let sum = 0;
  for (const sample of next) {
    const value = (sample - 128) / 128;
    sum += value * value;
  }
  return {
    level: Math.min(1, Math.sqrt(sum / next.length) * 7.5),
    samples: next,
  };
}

/** 频段分析统一使用的 FFT 大小：2048 → 1024 bin（约 47Hz/bin @48k）。 */
const ANALYSER_FFT_SIZE = 2048;
/**
 * 频谱平滑系数。0.82 的时间常数约 250ms，会把快速鼓点抹平；0.5 约 70ms，
 * 仍能压住逐帧抖动，但保留 20Hz 采样下的瞬态细节。场景侧还有一层平滑，
 * 不要把这里调回 0.8 以上。
 */
const ANALYSER_SMOOTHING = 0.5;

const SILENT_BANDS: AudioBands = {
  bass: 0,
  lowMid: 0,
  mid: 0,
  highMid: 0,
  treble: 0,
};

export type AudioReadResult = {
  source: AudioSource;
  active: boolean;
  level: { rms: number; peak: number };
  bands: AudioBands;
};

export class AudioGraph {
  private context: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private musicAnalyser: AnalyserNode | null = null;
  private noiseAnalyser: AnalyserNode | null = null;
  private mixAnalyser: AnalyserNode | null = null;
  private masterAnalyser: AnalyserNode | null = null;
  private musicSamples: Uint8Array<ArrayBuffer> | null = null;
  private noiseSamples: Uint8Array<ArrayBuffer> | null = null;
  private readonly audioTimeBuffers = new Map<
    AudioSource,
    Uint8Array<ArrayBuffer>
  >();
  private readonly audioFreqBuffers = new Map<
    AudioSource,
    Float32Array<ArrayBuffer>
  >();
  private readonly mediaSources = new Set<MediaElementAudioSourceNode>();
  private musicVolume = 1;
  private musicMuted = false;
  private noiseVolume = 0;
  private noiseMuted = false;
  private outputVolume = 1;
  private outputMuted = false;

  /** 创建/返回唯一的 AudioContext；失败时抛错，由调用方降级。 */
  ensure(): AudioContext {
    if (this.context && this.context.state !== "closed") return this.context;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) throw new Error("当前环境不支持 Web Audio");

    const context = new Ctor();
    const musicGain = context.createGain();
    const noiseGain = context.createGain();
    const mixGain = context.createGain();
    const masterGain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    const musicAnalyser = context.createAnalyser();
    const noiseAnalyser = context.createAnalyser();
    const mixAnalyser = context.createAnalyser();
    const masterAnalyser = context.createAnalyser();

    for (const analyser of [
      musicAnalyser,
      noiseAnalyser,
      mixAnalyser,
      masterAnalyser,
    ]) {
      analyser.fftSize = ANALYSER_FFT_SIZE;
      analyser.smoothingTimeConstant = ANALYSER_SMOOTHING;
    }

    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    musicGain.gain.value = busGain(this.musicVolume, this.musicMuted);
    noiseGain.gain.value = noiseBusGain(this.noiseVolume, this.noiseMuted);
    mixGain.gain.value = 1;
    masterGain.gain.value = outputGain(this.outputVolume, this.outputMuted);

    musicGain.connect(musicAnalyser);
    musicAnalyser.connect(mixGain);
    noiseGain.connect(noiseAnalyser);
    noiseAnalyser.connect(mixGain);
    mixGain.connect(mixAnalyser);
    mixAnalyser.connect(masterGain);
    masterGain.connect(masterAnalyser);
    masterAnalyser.connect(limiter);
    limiter.connect(context.destination);

    this.context = context;
    this.musicGain = musicGain;
    this.noiseGain = noiseGain;
    this.masterGain = masterGain;
    this.musicAnalyser = musicAnalyser;
    this.noiseAnalyser = noiseAnalyser;
    this.mixAnalyser = mixAnalyser;
    this.masterAnalyser = masterAnalyser;
    return context;
  }

  /** 浏览器自动播放策略兜底；引擎窗口已通过 Chromium 参数放行。 */
  resume(): void {
    const context = this.context;
    if (!context || context.state !== "suspended") return;
    void context.resume().catch(() => {});
  }

  get musicBus(): GainNode {
    this.ensure();
    if (!this.musicGain) throw new Error("AudioGraph musicBus 未初始化");
    return this.musicGain;
  }

  get noiseBus(): GainNode {
    this.ensure();
    if (!this.noiseGain) throw new Error("AudioGraph noiseBus 未初始化");
    return this.noiseGain;
  }

  setMusicVolume(volume: number, muted: boolean): void {
    this.musicVolume = clamp01(volume);
    this.musicMuted = muted;
    this.apply(this.musicGain, busGain(this.musicVolume, this.musicMuted));
  }

  setNoiseVolume(volume: number, muted: boolean): void {
    this.noiseVolume = clamp01(volume);
    this.noiseMuted = muted;
    this.apply(this.noiseGain, noiseBusGain(this.noiseVolume, this.noiseMuted));
  }

  setOutputVolume(volume: number, muted: boolean): void {
    this.outputVolume = clamp01(volume);
    this.outputMuted = muted;
    this.apply(
      this.masterGain,
      outputGain(this.outputVolume, this.outputMuted),
    );
  }

  attachMediaElement(element: HTMLMediaElement): MediaElementAudioSourceNode {
    if (!this.musicGain) throw new Error("AudioGraph musicBus 未初始化");
    return this.attachMediaElementTo(element, this.musicGain);
  }

  attachMediaElementTo(
    element: HTMLMediaElement,
    destination: AudioNode,
  ): MediaElementAudioSourceNode {
    const context = this.ensure();
    const source = context.createMediaElementSource(element);
    source.connect(destination);
    this.mediaSources.add(source);
    return source;
  }

  detachMediaElement(source: MediaElementAudioSourceNode | null): void {
    if (!source) return;
    try {
      source.disconnect();
    } catch {
      // 已断开时忽略。
    }
    this.mediaSources.delete(source);
  }

  musicLevel(): number {
    const result = rmsLevel(this.musicAnalyser, this.musicSamples);
    this.musicSamples = result.samples;
    return result.level;
  }

  noiseLevel(): number {
    const result = rmsLevel(this.noiseAnalyser, this.noiseSamples);
    this.noiseSamples = result.samples;
    return result.level;
  }

  /**
   * 读取单个来源的音频特征；未初始化或该来源没有分析节点时返回静音。
   *
   * `withBands=false` 时跳过频域读取，供只需要电平的订阅使用。
   */
  readAudio(source: AudioSource, withBands: boolean): AudioReadResult {
    const analyser = this.analyserFor(source);
    const context = this.context;
    if (!analyser || !context) {
      return {
        source,
        active: false,
        level: { rms: 0, peak: 0 },
        bands: { ...SILENT_BANDS },
      };
    }

    const time =
      this.audioTimeBuffers.get(source) ?? new Uint8Array(analyser.fftSize);
    this.audioTimeBuffers.set(source, time);
    analyser.getByteTimeDomainData(time);
    const metrics = timeDomainMetrics(time);

    let bands: AudioBands = { ...SILENT_BANDS };
    if (withBands) {
      const bins = analyser.frequencyBinCount;
      const frequency =
        this.audioFreqBuffers.get(source) ?? new Float32Array(bins);
      this.audioFreqBuffers.set(source, frequency);
      analyser.getFloatFrequencyData(frequency);
      bands = bandValuesFromDb(frequency, context.sampleRate, analyser.fftSize);
    }

    return {
      source,
      active: isAudioActive(metrics.rms),
      level: metrics,
      bands,
    };
  }

  private analyserFor(source: AudioSource): AnalyserNode | null {
    switch (source) {
      case "music":
        return this.musicAnalyser;
      case "noise":
        return this.noiseAnalyser;
      case "mix":
        return this.mixAnalyser;
      case "master":
        return this.masterAnalyser;
    }
  }

  dispose(): void {
    for (const source of this.mediaSources) {
      try {
        source.disconnect();
      } catch {
        // 忽略已断开的 source。
      }
    }
    this.mediaSources.clear();
    const context = this.context;
    this.context = null;
    this.musicGain = null;
    this.noiseGain = null;
    this.masterGain = null;
    this.musicAnalyser = null;
    this.noiseAnalyser = null;
    this.mixAnalyser = null;
    this.masterAnalyser = null;
    this.musicSamples = null;
    this.noiseSamples = null;
    this.audioTimeBuffers.clear();
    this.audioFreqBuffers.clear();
    if (context) void context.close().catch(() => {});
  }

  private apply(param: GainNode | null, value: number): void {
    if (!param) return;
    const context = this.context;
    if (!context) return;
    rampParam(param.gain, value, context.currentTime);
  }
}
