/**
 * EtherBubbles 的 Web Audio 混音器：五种环境声全部现场合成，不依赖音频资源。
 *
 * - 首次用户手势才创建 / 恢复 AudioContext（浏览器自动播放策略）。
 * - 每层有独立增益，主泡再串一层总音量；关闭某层只把它的增益拉到 0。
 * - 分析器把总输出 RMS 写回 CSS 变量 `--ether-pulse`，液体涟漪与呼吸随之起伏。
 */
"use client";

import {
  type RefObject,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { isWidgetAudioAvailable } from "@/sdk/widget";
import type { ChannelMap, MixState, SoundId } from "./sound-model";

/** 单层最大增益：五层同时拉满也留出余量。 */
const CHANNEL_GAIN = 0.34;
const MASTER_GAIN = 0.9;

type Engine = {
  context: AudioContext;
  master: GainNode;
  analyser: AnalyserNode;
  gains: Record<SoundId, GainNode>;
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
  // 棕噪音的泄漏积分振幅不可预测，按峰值归一化，避免不同机器上音量差异过大。
  const scale = peak > 0 ? 0.86 / peak : 1;
  for (let i = 0; i < length; i += 1) data[i] *= scale;
  return buffer;
}

/** 稀疏的爆裂声：篝火的高频噼啪，不需要外部音效。 */
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

type Layer = {
  gain: GainNode;
  filter: BiquadFilterNode;
};

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

/** 把超低频振荡器接到 AudioParam，形成潮汐 / 风压式的缓慢起伏。 */
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
  id: SoundId,
  destination: AudioNode,
  white: AudioBuffer,
  brown: AudioBuffer,
  crackle: AudioBuffer,
): void {
  switch (id) {
    case "rain": {
      // 一层连续的雨幕 + 一层偏高频的细碎雨点。
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
    default: {
      const exhaustive: never = id;
      throw new Error(`未知声景：${String(exhaustive)}`);
    }
  }
}

function buildEngine(context: AudioContext): Engine {
  const master = context.createGain();
  // 先静音，等 React 把当前混音状态同步进来，避免上电瞬间爆音。
  master.gain.value = 0;

  const analyser = context.createAnalyser();
  analyser.fftSize = 512;
  analyser.smoothingTimeConstant = 0.82;

  master.connect(analyser);
  analyser.connect(context.destination);

  const white = makeNoiseBuffer(context, "white");
  const brown = makeNoiseBuffer(context, "brown");
  const crackle = makeCrackleBuffer(context);

  const gains = {} as Record<SoundId, GainNode>;
  for (const id of [
    "rain",
    "thunder",
    "wind",
    "waves",
    "fire",
  ] as const satisfies readonly SoundId[]) {
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

export type AmbientMixer = {
  awake: boolean;
  start: () => Promise<void>;
  sync: (mix: MixState) => void;
};

export function useAmbientMixer(
  pulseTarget: RefObject<HTMLElement | null>,
): AmbientMixer {
  const engineRef = useRef<Engine | null>(null);
  const startingRef = useRef<Promise<void> | null>(null);
  const rafRef = useRef(0);
  const [awake, setAwake] = useState(false);

  const runAnalyser = useCallback((): void => {
    cancelAnimationFrame(rafRef.current);
    const engine = engineRef.current;
    if (!engine) return;

    const samples = new Uint8Array(new ArrayBuffer(engine.analyser.fftSize));
    let last = 0;

    const tick = (time: number): void => {
      if (!engineRef.current) return;
      if (time - last > 55) {
        last = time;
        engine.analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (let i = 0; i < samples.length; i += 1) {
          const value = (samples[i] - 128) / 128;
          sum += value * value;
        }
        const rms = Math.sqrt(sum / samples.length);
        const pulse = Math.min(1, rms * 7.5);
        pulseTarget.current?.style.setProperty(
          "--ether-pulse",
          pulse.toFixed(3),
        );
      }
      rafRef.current = requestAnimationFrame(tick);
    };

    rafRef.current = requestAnimationFrame(tick);
  }, [pulseTarget]);

  const start = useCallback(async (): Promise<void> => {
    if (!isWidgetAudioAvailable()) return;
    const existing = engineRef.current;
    if (existing) {
      try {
        await existing.context.resume();
      } catch (error) {
        console.error("[ether] 恢复音频上下文失败", error);
      }
      return;
    }
    const pending = startingRef.current;
    if (pending) {
      return pending;
    }

    const boot = (async (): Promise<void> => {
      if (typeof window === "undefined") return;
      const Ctor =
        typeof window.AudioContext === "function"
          ? window.AudioContext
          : (
              window as unknown as {
                webkitAudioContext?: typeof AudioContext;
              }
            ).webkitAudioContext;
      if (!Ctor) return;

      let context: AudioContext;
      try {
        context = new Ctor();
      } catch (error) {
        console.error("[ether] 创建音频上下文失败", error);
        return;
      }

      engineRef.current = buildEngine(context);
      try {
        await context.resume();
      } catch (error) {
        console.error("[ether] 启动音频上下文失败", error);
      }
      setAwake(true);
      runAnalyser();
    })();

    startingRef.current = boot;
    try {
      await boot;
    } finally {
      startingRef.current = null;
    }
  }, [runAnalyser]);

  const sync = useCallback((mix: MixState): void => {
    const engine = engineRef.current;
    if (!engine) return;
    const now = engine.context.currentTime;
    const masterValue = mix.muted ? 0 : (mix.master / 100) * MASTER_GAIN;
    ramp(engine.master.gain, masterValue, now);

    const channels: ChannelMap = mix.channels;
    for (const id of Object.keys(channels) as SoundId[]) {
      const channel = channels[id];
      const value = channel.enabled ? (channel.level / 100) * CHANNEL_GAIN : 0;
      ramp(engine.gains[id].gain, value, now);
    }
  }, []);

  useEffect(
    () => () => {
      cancelAnimationFrame(rafRef.current);
      const engine = engineRef.current;
      engineRef.current = null;
      if (!engine) return;
      pulseTarget.current?.style.setProperty("--ether-pulse", "0");
      void engine.context.close().catch((error: unknown) => {
        console.error("[ether] 关闭音频上下文失败", error);
      });
    },
    [pulseTarget],
  );

  return { awake, start, sync };
}
