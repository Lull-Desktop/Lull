/**
 * Music 与 Noise 唯一的 AudioGraph。
 *
 * 一个 AudioContext、两条业务总线、一个 master 与 limiter：
 *
 *   musicBus ─┐
 *             ├─ master ─ limiter ─ destination
 *   noiseBus ─┘
 *
 * 业务层只设置音量/静音，不直接连接 destination；设备切换由 host 重载引擎后
 * 由 Rust 全量 resync。
 */
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

export class AudioGraph {
  private context: AudioContext | null = null;
  private musicGain: GainNode | null = null;
  private noiseGain: GainNode | null = null;
  private masterGain: GainNode | null = null;
  private musicAnalyser: AnalyserNode | null = null;
  private noiseAnalyser: AnalyserNode | null = null;
  private musicSamples: Uint8Array<ArrayBuffer> | null = null;
  private noiseSamples: Uint8Array<ArrayBuffer> | null = null;
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
    const masterGain = context.createGain();
    const limiter = context.createDynamicsCompressor();
    const musicAnalyser = context.createAnalyser();
    const noiseAnalyser = context.createAnalyser();

    musicAnalyser.fftSize = 512;
    musicAnalyser.smoothingTimeConstant = 0.82;
    noiseAnalyser.fftSize = 512;
    noiseAnalyser.smoothingTimeConstant = 0.82;

    limiter.threshold.value = -6;
    limiter.knee.value = 0;
    limiter.ratio.value = 20;
    limiter.attack.value = 0.003;
    limiter.release.value = 0.25;

    musicGain.gain.value = busGain(this.musicVolume, this.musicMuted);
    noiseGain.gain.value = noiseBusGain(this.noiseVolume, this.noiseMuted);
    masterGain.gain.value = outputGain(this.outputVolume, this.outputMuted);

    musicGain.connect(musicAnalyser);
    musicAnalyser.connect(masterGain);
    noiseGain.connect(noiseAnalyser);
    noiseAnalyser.connect(masterGain);
    masterGain.connect(limiter);
    limiter.connect(context.destination);

    this.context = context;
    this.musicGain = musicGain;
    this.noiseGain = noiseGain;
    this.masterGain = masterGain;
    this.musicAnalyser = musicAnalyser;
    this.noiseAnalyser = noiseAnalyser;
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
    this.musicSamples = null;
    this.noiseSamples = null;
    if (context) void context.close().catch(() => {});
  }

  private apply(param: GainNode | null, value: number): void {
    if (!param) return;
    const context = this.context;
    if (!context) return;
    rampParam(param.gain, value, context.currentTime);
  }
}
