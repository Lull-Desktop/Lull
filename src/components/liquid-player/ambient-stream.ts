/**
 * 在线精选曲目的实时合成引擎。
 *
 * 应用没有把「在线」做成网络串流，而是用 Web Audio 现场铺一层缓慢的氛围垫底：
 * 四小节和弦循环 + 低音 + 稀疏铃音 + 空气底噪，全部经过一段程序生成的混响。
 * 这样列表里的曲目在不联网时也能真正播放，并且持续提供主球频响涟漪所需的电平。
 */
import type { AmbientPreset } from "./player-model";

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

function midiToFrequency(midi: number): number {
  return 440 * 2 ** ((midi - 69) / 12);
}

/** 指数衰减的白噪声脉冲，用作轻量混响。 */
function createImpulse(
  context: AudioContext,
  seconds: number,
  decay: number,
): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * seconds));
  const buffer = context.createBuffer(2, length, context.sampleRate);
  for (let channel = 0; channel < buffer.numberOfChannels; channel += 1) {
    const data = buffer.getChannelData(channel);
    for (let index = 0; index < length; index += 1) {
      const envelope = (1 - index / length) ** decay;
      data[index] = (Math.random() * 2 - 1) * envelope;
    }
  }
  return buffer;
}

/** 两秒循环的空气底噪，让和弦之间有呼吸感。 */
function createAirBuffer(context: AudioContext): AudioBuffer {
  const length = Math.max(1, Math.floor(context.sampleRate * 2));
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  let previous = 0;
  for (let index = 0; index < length; index += 1) {
    const white = Math.random() * 2 - 1;
    previous = previous * 0.92 + white * 0.08;
    data[index] = previous;
  }
  return buffer;
}

export class AmbientStream {
  private context: AudioContext | null = null;
  private input: GainNode | null = null;
  private master: GainNode | null = null;
  private analyser: AnalyserNode | null = null;
  private noiseGain: GainNode | null = null;
  private noiseSource: AudioBufferSourceNode | null = null;
  private sources = new Set<AudioScheduledSourceNode>();
  private timer: number | null = null;
  private preset: AmbientPreset | null = null;
  private running = false;
  private volume = 78;
  private barDuration = 4;
  private nextBarIndex = 0;
  private nextBarTime = 0;
  private seedState = 1;
  private smoothedLevel = 0;
  private frequencyData: Uint8Array<ArrayBuffer> | null = null;

  private ensureContext(): AudioContext {
    if (this.context) return this.context;
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) throw new Error("当前环境不支持 Web Audio");
    const context = new Ctor();
    const input = context.createGain();
    input.gain.value = 1;
    const master = context.createGain();
    master.gain.value = 0.0001;
    const analyser = context.createAnalyser();
    analyser.fftSize = 128;
    analyser.smoothingTimeConstant = 0.84;

    const dry = context.createGain();
    dry.gain.value = 0.72;
    const wet = context.createGain();
    wet.gain.value = 0.55;
    const convolver = context.createConvolver();
    convolver.buffer = createImpulse(context, 2.8, 2.4);

    input.connect(dry);
    dry.connect(master);
    input.connect(convolver);
    convolver.connect(wet);
    wet.connect(master);
    master.connect(analyser);
    analyser.connect(context.destination);

    this.context = context;
    this.input = input;
    this.master = master;
    this.analyser = analyser;
    this.startAir();
    return context;
  }

  private startAir(): void {
    const context = this.context;
    const input = this.input;
    if (!context || !input || this.noiseSource) return;
    const source = context.createBufferSource();
    source.buffer = createAirBuffer(context);
    source.loop = true;
    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.value = 760;
    const gain = context.createGain();
    gain.gain.value = 0.0001;
    source.connect(filter);
    filter.connect(gain);
    gain.connect(input);
    source.start();
    this.noiseSource = source;
    this.noiseGain = gain;
  }

  private targetGain(): number {
    return this.volume <= 0 ? 0.0001 : 0.92 * (this.volume / 100);
  }

  private random(): number {
    this.seedState = (this.seedState * 1664525 + 1013904223) >>> 0;
    return this.seedState / 4294967296;
  }

  private trackSource(source: AudioScheduledSourceNode): void {
    this.sources.add(source);
    source.addEventListener(
      "ended",
      () => {
        this.sources.delete(source);
      },
      { once: true },
    );
  }

  private scheduleTone(options: {
    frequency: number;
    type: OscillatorType;
    start: number;
    duration: number;
    peak: number;
    attack: number;
    destination: AudioNode;
    detune?: number;
  }): void {
    const context = this.context;
    if (!context) return;
    const oscillator = context.createOscillator();
    const gain = context.createGain();
    oscillator.type = options.type;
    oscillator.frequency.setValueAtTime(options.frequency, options.start);
    if (options.detune) {
      oscillator.detune.setValueAtTime(options.detune, options.start);
    }
    const end = options.start + options.duration;
    const sustainAt =
      options.start + Math.min(options.duration * 0.72, options.attack + 1.6);
    gain.gain.setValueAtTime(0.0001, options.start);
    gain.gain.exponentialRampToValueAtTime(
      Math.max(0.0002, options.peak),
      options.start + options.attack,
    );
    gain.gain.setValueAtTime(
      Math.max(0.0002, options.peak),
      Math.max(options.start + options.attack, sustainAt),
    );
    gain.gain.exponentialRampToValueAtTime(0.0001, end);
    oscillator.connect(gain);
    gain.connect(options.destination);
    oscillator.start(options.start);
    oscillator.stop(end + 0.05);
    this.trackSource(oscillator);
  }

  private scheduleBar(barIndex: number, when: number, attack: number): void {
    const context = this.context;
    const input = this.input;
    const preset = this.preset;
    if (!context || !input || !preset) return;
    const chord =
      preset.chords[barIndex % preset.chords.length] ?? preset.chords[0];
    if (!chord || chord.length === 0) return;

    const filter = context.createBiquadFilter();
    filter.type = "lowpass";
    filter.frequency.setValueAtTime(preset.brightness, when);
    filter.Q.value = 0.32;
    filter.connect(input);

    const duration = this.barDuration * 1.08;
    chord.forEach((midi, index) => {
      this.scheduleTone({
        frequency: midiToFrequency(midi),
        type: preset.wave,
        start: when,
        duration,
        peak: 0.013,
        attack,
        destination: filter,
        detune: (index - (chord.length - 1) / 2) * 3.5,
      });
    });

    const bass = Math.min(...chord) - 12;
    this.scheduleTone({
      frequency: midiToFrequency(bass),
      type: "sine",
      start: when,
      duration: duration * 1.04,
      peak: 0.04,
      attack: Math.min(1.6, attack + 0.4),
      destination: filter,
    });

    // 每小节一到两枚高音铃，位置由固定种子决定，重播时纹理一致。
    const bells = this.random() > 0.42 ? 2 : 1;
    for (let index = 0; index < bells; index += 1) {
      const note =
        preset.melody[Math.floor(this.random() * preset.melody.length)] ??
        preset.melody[0];
      if (note === undefined) continue;
      const offset = this.random() * this.barDuration * 0.82;
      this.scheduleTone({
        frequency: midiToFrequency(note),
        type: "sine",
        start: when + offset,
        duration: 3.4,
        peak: 0.016,
        attack: 0.015,
        destination: input,
      });
    }
  }

  private tick(): void {
    const context = this.context;
    if (!context || !this.running) return;
    const horizon = context.currentTime + 1.1;
    let guard = 0;
    while (this.nextBarTime < horizon && guard < 8) {
      this.scheduleBar(this.nextBarIndex, this.nextBarTime, 1.1);
      this.nextBarIndex += 1;
      this.nextBarTime += this.barDuration;
      guard += 1;
    }
  }

  private stopSources(): void {
    const context = this.context;
    const when = (context?.currentTime ?? 0) + 0.07;
    for (const source of this.sources) {
      try {
        source.stop(when);
      } catch {
        // 已经停止的源重复 stop 会抛错，忽略即可。
      }
    }
    this.sources.clear();
  }

  /** 开始或跳转到 offset 秒；重复调用会重置当前调度。 */
  start(preset: AmbientPreset, offset = 0): void {
    const context = this.ensureContext();
    if (context.state === "suspended") {
      void context.resume().catch(() => {
        // 自动播放策略可能拒绝 resume；播放按钮状态会由组件兜底。
      });
    }
    this.stopSources();
    this.preset = preset;
    this.seedState = preset.seed || 1;
    this.barDuration = (60 / preset.bpm) * 4;
    this.running = true;

    const now = context.currentTime;
    this.master?.gain.cancelScheduledValues(now);
    this.master?.gain.setTargetAtTime(this.targetGain(), now, 0.18);
    this.noiseGain?.gain.setTargetAtTime(0.012 + preset.air * 0.02, now, 0.4);

    const safeOffset = Math.max(0, offset);
    const currentBar = Math.floor(safeOffset / this.barDuration);
    const phase = safeOffset - currentBar * this.barDuration;
    const currentBarTime = now;
    this.scheduleBar(currentBar, currentBarTime, 1.2);
    this.nextBarIndex = currentBar + 1;
    this.nextBarTime = now + (this.barDuration - phase);

    if (this.timer !== null) window.clearInterval(this.timer);
    this.timer = window.setInterval(() => this.tick(), 140);
    this.tick();
  }

  stop(): void {
    this.running = false;
    if (this.timer !== null) {
      window.clearInterval(this.timer);
      this.timer = null;
    }
    const context = this.context;
    if (context) {
      const now = context.currentTime;
      this.master?.gain.cancelScheduledValues(now);
      this.master?.gain.setTargetAtTime(0.0001, now, 0.05);
      this.noiseGain?.gain.setTargetAtTime(0.0001, now, 0.08);
    }
    this.stopSources();
    this.smoothedLevel = 0;
  }

  setVolume(volume: number): void {
    this.volume = volume;
    const context = this.context;
    if (!context) return;
    this.master?.gain.setTargetAtTime(
      this.running ? this.targetGain() : 0.0001,
      context.currentTime,
      0.08,
    );
  }

  /** 0–1 的平滑电平，用于主球内壁频响涟漪。 */
  level(): number {
    const analyser = this.analyser;
    if (!this.running || !analyser) return 0;
    if (
      !this.frequencyData ||
      this.frequencyData.length !== analyser.frequencyBinCount
    ) {
      this.frequencyData = new Uint8Array(analyser.frequencyBinCount);
    }
    analyser.getByteFrequencyData(this.frequencyData);
    const limit = Math.min(this.frequencyData.length, 44);
    let sum = 0;
    for (let index = 1; index < limit; index += 1) {
      sum += this.frequencyData[index] ?? 0;
    }
    const average = sum / Math.max(1, (limit - 1) * 255);
    const target = Math.min(1, average * 2.1);
    this.smoothedLevel = this.smoothedLevel * 0.74 + target * 0.26;
    return this.smoothedLevel;
  }

  dispose(): void {
    this.stop();
    const context = this.context;
    this.context = null;
    this.input = null;
    this.master = null;
    this.analyser = null;
    this.noiseGain = null;
    this.noiseSource = null;
    this.preset = null;
    this.frequencyData = null;
    if (context) {
      void context.close().catch(() => {
        // 窗口关闭阶段上下文可能已经进入 closed，无需再处理。
      });
    }
  }
}
