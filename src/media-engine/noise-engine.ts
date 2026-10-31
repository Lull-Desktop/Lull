/**
 * 引擎侧白噪音混音图。逻辑从 `use-ambient-mixer` 迁出，去掉 React/授权判断；
 * 状态由 Rust 服务下发，这里只同步增益并输出 RMS 电平。
 */
import type { NoiseLayer } from "./protocol";

const CHANNEL_GAIN = 0.34;
const MASTER_GAIN = 0.9;

type Engine = {
  context: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  gains: Record<string, GainNode>;
};

type BufferKind = "white" | "brown";

function makeNoiseBuffer(
  context: AudioContext,
  kind: BufferKind,
  seconds = 4,
): AudioBuffer {
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);

  if (kind === "white") {
    for (let i = 0; i < length; i += 1) {
      data[i] = (Math.random() * 2 - 1) * 0.82;
    }
    return buffer;
  }

  let last = 0;
  let peak = 0;
  for (let i = 0; i < length; i += 1) {
    const white = Math.random() * 2 - 1;
    last = (last + 0.02 * white) / 1.02;
    data[i] = last;
    peak = Math.max(peak, Math.abs(last));
  }
  const scale = peak > 0 ? 0.86 / peak : 1;
  for (let i = 0; i < length; i += 1) data[i] *= scale;
  return buffer;
}

function makeCrackleBuffer(context: AudioContext): AudioBuffer {
  const seconds = 5;
  const length = Math.floor(context.sampleRate * seconds);
  const buffer = context.createBuffer(1, length, context.sampleRate);
  const data = buffer.getChannelData(0);
  const density = 0.00042;
  const grain = Math.floor(context.sampleRate * 0.018);

  for (let i = 0; i < length; i += 1) {
    if (Math.random() > density) continue;
    const amp = 0.25 + Math.random() * 0.65;
    for (let j = 0; j < grain && i + j < length; j += 1) {
      const decay = 1 - j / grain;
      data[i + j] += (Math.random() * 2 - 1) * amp * decay * decay;
    }
  }
  return buffer;
}

function loopSource(
  context: AudioContext,
  buffer: AudioBuffer,
): AudioBufferSourceNode {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start();
  return source;
}

type Layer = { gain: GainNode; filter: BiquadFilterNode };

function connectLayer(
  context: AudioContext,
  buffer: AudioBuffer,
  type: BiquadFilterType,
  frequency: number,
  q: number,
  gainValue: number,
  destination: AudioNode,
): Layer {
  const source = loopSource(context, buffer);
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const gain = context.createGain();
  gain.gain.value = gainValue;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  return { gain, filter };
}

function addLfo(
  context: AudioContext,
  param: AudioParam,
  rate: number,
  depth: number,
  center: number,
): void {
  param.value = center;
  const oscillator = context.createOscillator();
  oscillator.type = "sine";
  oscillator.frequency.value = rate;
  const amount = context.createGain();
  amount.gain.value = depth;
  oscillator.connect(amount);
  amount.connect(param);
  oscillator.start();
}

function buildChannel(
  context: AudioContext,
  id: string,
  destination: AudioNode,
  white: AudioBuffer,
  brown: AudioBuffer,
  crackle: AudioBuffer,
): void {
  switch (id) {
    case "rain": {
      connectLayer(context, white, "highpass", 850, 0.7, 0.5, destination);
      const detail = connectLayer(
        context,
        white,
        "bandpass",
        3600,
        0.85,
        0.2,
        destination,
      );
      addLfo(context, detail.gain.gain, 0.13, 0.06, 0.2);
      break;
    }
    case "thunder": {
      const rumble = connectLayer(
        context,
        brown,
        "lowpass",
        115,
        1.1,
        0.72,
        destination,
      );
      addLfo(context, rumble.gain.gain, 0.043, 0.25, 0.72);
      const sub = connectLayer(
        context,
        brown,
        "lowpass",
        56,
        0.8,
        0.38,
        destination,
      );
      addLfo(context, sub.gain.gain, 0.027, 0.18, 0.38);
      break;
    }
    case "wind": {
      const body = connectLayer(
        context,
        white,
        "bandpass",
        520,
        1.4,
        0.34,
        destination,
      );
      addLfo(context, body.filter.frequency, 0.068, 260, 520);
      addLfo(context, body.gain.gain, 0.11, 0.14, 0.34);
      connectLayer(context, white, "highpass", 2400, 0.6, 0.055, destination);
      break;
    }
    case "waves": {
      const swell = connectLayer(
        context,
        brown,
        "lowpass",
        680,
        0.75,
        0.6,
        destination,
      );
      addLfo(context, swell.gain.gain, 0.058, 0.28, 0.6);
      addLfo(context, swell.filter.frequency, 0.041, 180, 680);
      connectLayer(context, white, "bandpass", 1400, 0.7, 0.08, destination);
      break;
    }
    case "fire": {
      const bed = connectLayer(
        context,
        brown,
        "lowpass",
        1100,
        0.6,
        0.34,
        destination,
      );
      addLfo(context, bed.gain.gain, 0.19, 0.05, 0.34);
      connectLayer(context, crackle, "highpass", 1700, 0.7, 0.32, destination);
      break;
    }
    default:
      break;
  }
}

function buildEngine(context: AudioContext): Engine {
  const master = context.createGain();
  master.gain.value = 0;
  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.82;
  master.connect(analyser);
  analyser.connect(context.destination);

  const white = makeNoiseBuffer(context, "white");
  const brown = makeNoiseBuffer(context, "brown");
  const crackle = makeCrackleBuffer(context);
  const gains: Record<string, GainNode> = {};
  for (const id of ["rain", "thunder", "wind", "waves", "fire"]) {
    const gain = context.createGain();
    gain.gain.value = 0;
    gain.connect(master);
    gains[id] = gain;
    buildChannel(context, id, gain, white, brown, crackle);
  }
  return { context, master, analyser, gains };
}

function ramp(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, 0.045);
}

export class NoiseEngine {
  private engine: Engine | null = null;
  private samples: Uint8Array<ArrayBuffer> | null = null;

  private ensure(): Engine | null {
    if (this.engine) return this.engine;
    if (
      typeof window === "undefined" ||
      typeof window.AudioContext !== "function"
    ) {
      return null;
    }
    try {
      const context = new window.AudioContext();
      this.engine = buildEngine(context);
      return this.engine;
    } catch {
      return null;
    }
  }

  async start(): Promise<void> {
    const engine = this.ensure();
    if (!engine) return;
    try {
      await engine.context.resume();
    } catch {
      // 自动播放策略可能拒绝；宿主会通过 browser args 放行，失败不崩。
    }
  }

  sync(
    active: boolean,
    master: number,
    muted: boolean,
    layers: NoiseLayer[],
  ): void {
    const engine = this.ensure();
    if (!engine) return;
    void this.start();
    const now = engine.context.currentTime;
    const masterValue = !active || muted ? 0 : master * MASTER_GAIN;
    ramp(engine.master.gain, masterValue, now);
    for (const layer of layers) {
      const gain = engine.gains[layer.soundId];
      if (!gain) continue;
      const value = layer.enabled ? layer.volume * CHANNEL_GAIN : 0;
      ramp(gain.gain, value, now);
    }
  }

  level(): number {
    const engine = this.engine;
    if (!engine) return 0;
    if (!this.samples || this.samples.length !== engine.analyser.fftSize) {
      this.samples = new Uint8Array(engine.analyser.fftSize);
    }
    engine.analyser.getByteTimeDomainData(this.samples);
    let sum = 0;
    for (let index = 0; index < this.samples.length; index += 1) {
      const value = ((this.samples[index] ?? 128) - 128) / 128;
      sum += value * value;
    }
    return Math.min(1, Math.sqrt(sum / this.samples.length) * 7.5);
  }

  dispose(): void {
    const engine = this.engine;
    this.engine = null;
    this.samples = null;
    if (engine) void engine.context.close().catch(() => {});
  }
}
