/**
 * 引擎侧 Noise 多轨混音图。
 *
 * Rust 下发完整的 Session 快照（trackId + source + gain + enabled + state），
 * 这里按 trackId 维护动态声道；内置 procedural profile 由本地合成器生成，
 * 本地文件用 `<audio>` 接入共享 `noiseBus`。
 */
import type { AudioGraph } from "./audio-graph";
import { trackGain } from "./gain";
import type { NoiseSessionCommand, NoiseTrackCommand } from "./protocol";

type Buffers = {
  white: AudioBuffer;
  brown: AudioBuffer;
  crackle: AudioBuffer;
};

type ProceduralVoice = {
  kind: "procedural";
  gain: GainNode;
  sources: AudioScheduledSourceNode[];
  nodes: AudioNode[];
};

type AssetVoice = {
  kind: "asset";
  gain: GainNode;
  audio: HTMLAudioElement;
  detach: () => void;
};

type Voice = ProceduralVoice | AssetVoice;

type Engine = {
  context: AudioContext;
  buffers: Buffers;
  tracks: Map<string, Voice>;
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
  voice: ProceduralVoice,
): AudioBufferSourceNode {
  const source = context.createBufferSource();
  source.buffer = buffer;
  source.loop = true;
  source.start();
  voice.sources.push(source);
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
  voice: ProceduralVoice,
): Layer {
  const source = loopSource(context, buffer, voice);
  const filter = context.createBiquadFilter();
  filter.type = type;
  filter.frequency.value = frequency;
  filter.Q.value = q;
  const gain = context.createGain();
  gain.gain.value = gainValue;
  source.connect(filter);
  filter.connect(gain);
  gain.connect(destination);
  voice.nodes.push(filter, gain);
  return { gain, filter };
}

function addLfo(
  context: AudioContext,
  param: AudioParam,
  rate: number,
  depth: number,
  center: number,
  voice: ProceduralVoice,
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
  voice.sources.push(oscillator);
  voice.nodes.push(amount);
}

function buildChannel(
  context: AudioContext,
  id: string,
  destination: AudioNode,
  buffers: Buffers,
  voice: ProceduralVoice,
): void {
  switch (id) {
    case "rain": {
      connectLayer(
        context,
        buffers.white,
        "highpass",
        850,
        0.7,
        0.5,
        destination,
        voice,
      );
      const detail = connectLayer(
        context,
        buffers.white,
        "bandpass",
        3600,
        0.85,
        0.2,
        destination,
        voice,
      );
      addLfo(context, detail.gain.gain, 0.13, 0.06, 0.2, voice);
      break;
    }
    case "thunder": {
      const rumble = connectLayer(
        context,
        buffers.brown,
        "lowpass",
        115,
        1.1,
        0.72,
        destination,
        voice,
      );
      addLfo(context, rumble.gain.gain, 0.043, 0.25, 0.72, voice);
      const sub = connectLayer(
        context,
        buffers.brown,
        "lowpass",
        56,
        0.8,
        0.38,
        destination,
        voice,
      );
      addLfo(context, sub.gain.gain, 0.027, 0.18, 0.38, voice);
      break;
    }
    case "wind": {
      const body = connectLayer(
        context,
        buffers.white,
        "bandpass",
        520,
        1.4,
        0.34,
        destination,
        voice,
      );
      addLfo(context, body.filter.frequency, 0.068, 260, 520, voice);
      addLfo(context, body.gain.gain, 0.11, 0.14, 0.34, voice);
      connectLayer(
        context,
        buffers.white,
        "highpass",
        2400,
        0.6,
        0.055,
        destination,
        voice,
      );
      break;
    }
    case "waves": {
      const swell = connectLayer(
        context,
        buffers.brown,
        "lowpass",
        680,
        0.75,
        0.6,
        destination,
        voice,
      );
      addLfo(context, swell.gain.gain, 0.058, 0.28, 0.6, voice);
      addLfo(context, swell.filter.frequency, 0.041, 180, 680, voice);
      connectLayer(
        context,
        buffers.white,
        "bandpass",
        1400,
        0.7,
        0.08,
        destination,
        voice,
      );
      break;
    }
    case "fire": {
      const bed = connectLayer(
        context,
        buffers.brown,
        "lowpass",
        1100,
        0.6,
        0.34,
        destination,
        voice,
      );
      addLfo(context, bed.gain.gain, 0.19, 0.05, 0.34, voice);
      connectLayer(
        context,
        buffers.crackle,
        "highpass",
        1700,
        0.7,
        0.32,
        destination,
        voice,
      );
      break;
    }
    default:
      break;
  }
}

function buildVoice(
  context: AudioContext,
  profile: string,
  buffers: Buffers,
  destination: AudioNode,
): ProceduralVoice {
  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(destination);
  const voice: ProceduralVoice = {
    kind: "procedural",
    gain,
    sources: [],
    nodes: [],
  };
  buildChannel(context, profile, gain, buffers, voice);
  return voice;
}

function buildAssetVoice(
  graph: AudioGraph,
  track: NoiseTrackCommand,
  destination: AudioNode,
): AssetVoice {
  if (track.source.kind !== "asset") {
    throw new Error("asset voice 需要 asset source");
  }
  const context = graph.ensure();
  const gain = context.createGain();
  gain.gain.value = 0;
  gain.connect(destination);
  const audio = new Audio();
  audio.crossOrigin = "anonymous";
  audio.preload = "auto";
  audio.loop = track.loop;
  audio.src = track.source.url;
  const source = graph.attachMediaElementTo(audio, gain);
  audio.load();
  return {
    kind: "asset",
    gain,
    audio,
    detach: () => graph.detachMediaElement(source),
  };
}

function disposeVoice(voice: Voice): void {
  if (voice.kind === "asset") {
    try {
      voice.audio.pause();
      voice.audio.removeAttribute("src");
      voice.audio.load();
    } catch {
      // 已释放时忽略。
    }
    voice.detach();
    try {
      voice.gain.disconnect();
    } catch {
      // 已断开时忽略。
    }
    return;
  }
  for (const source of voice.sources) {
    try {
      source.stop();
    } catch {
      // 已停止的源重复 stop 会抛错，忽略。
    }
    try {
      source.disconnect();
    } catch {
      // 已断开时忽略。
    }
  }
  for (const node of voice.nodes) {
    try {
      node.disconnect();
    } catch {
      // 已断开时忽略。
    }
  }
  try {
    voice.gain.disconnect();
  } catch {
    // 已断开时忽略。
  }
}

function ensureBuffers(context: AudioContext): Buffers {
  return {
    white: makeNoiseBuffer(context, "white"),
    brown: makeNoiseBuffer(context, "brown"),
    crackle: makeCrackleBuffer(context),
  };
}

function ramp(param: AudioParam, value: number, now: number): void {
  param.cancelScheduledValues(now);
  param.setTargetAtTime(value, now, 0.045);
}

export class NoiseEngine {
  private readonly graph: AudioGraph;
  private engine: Engine | null = null;

  constructor(graph: AudioGraph) {
    this.graph = graph;
  }

  private ensure(): Engine | null {
    if (this.engine) return this.engine;
    try {
      const context = this.graph.ensure();
      this.engine = {
        context,
        buffers: ensureBuffers(context),
        tracks: new Map(),
      };
      return this.engine;
    } catch {
      return null;
    }
  }

  start(): void {
    if (!this.ensure()) return;
    this.graph.resume();
  }

  sync(command: NoiseSessionCommand): void {
    const engine = this.ensure();
    if (!engine) return;
    this.start();
    this.graph.setNoiseVolume(
      command.state === "playing" ? command.master : 0,
      command.muted,
    );
    const now = engine.context.currentTime;
    const live = new Set<string>();
    for (const track of command.tracks) {
      live.add(track.trackId);
      let voice = engine.tracks.get(track.trackId);
      if (!voice) {
        voice =
          track.source.kind === "procedural"
            ? buildVoice(
                engine.context,
                track.source.profile,
                engine.buffers,
                this.graph.noiseBus,
              )
            : buildAssetVoice(this.graph, track, this.graph.noiseBus);
        engine.tracks.set(track.trackId, voice);
      }
      const active = track.enabled && command.state === "playing";
      if (voice.kind === "asset") {
        voice.audio.loop = track.loop;
        if (active && voice.audio.paused) {
          void voice.audio.play().catch(() => {});
        } else if (!active && !voice.audio.paused) {
          voice.audio.pause();
        }
      }
      ramp(
        voice.gain.gain,
        trackGain(track.volume, track.enabled, command.state === "playing"),
        now,
      );
    }
    for (const [trackId, voice] of engine.tracks) {
      if (!live.has(trackId)) {
        disposeVoice(voice);
        engine.tracks.delete(trackId);
      }
    }
  }

  level(): number {
    return this.engine ? this.graph.noiseLevel() : 0;
  }

  dispose(): void {
    if (this.engine) {
      for (const voice of this.engine.tracks.values()) {
        disposeVoice(voice);
      }
      this.engine = null;
    }
  }
}
