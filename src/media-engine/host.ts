/**
 * 隐藏音频引擎入口：接收宿主命令、驱动 PlayerEngine/NoiseEngine，并上报事件。
 *
 * 页面不渲染任何 UI；Rust 负责业务状态与权限，这里只负责“实际发声”。N1 起
 * 所有声音都进入同一个 AudioGraph；设备切换时最稳妥的恢复方式是重载本页，
 * Rust 收到 ready 后会全量 resync。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { AudioSource } from "@/sdk/scene";
import { AudioGraph } from "./audio-graph";
import { NoiseEngine } from "./noise-engine";
import { PlayerEngine } from "./player-engine";
import type { EngineAudioFrame, EngineCommand, EngineEvent } from "./protocol";

let started = false;
let reloading = false;

async function send(event: EngineEvent): Promise<void> {
  try {
    await invoke("media_engine_event", { event });
  } catch {
    // 宿主销毁/权限收紧时忽略；下次 ready 会重新对账。
  }
}

export async function startMediaEngineHost(): Promise<void> {
  if (started) return;
  started = true;

  const graph = new AudioGraph();
  const player = new PlayerEngine((event) => {
    void send(event);
  }, graph);
  const noise = new NoiseEngine(graph);
  let levelTimer = 0;
  let audioTimer = 0;
  let audioSources: AudioSource[] = [];
  let audioBands = false;
  let audioIntervalMs = 50;

  const updateLevels = (): void => {
    if (levelTimer !== 0) return;
    levelTimer = window.setInterval(() => {
      void send({
        type: "levels",
        player: player.level(),
        noise: noise.level(),
      });
    }, 50);
  };

  const stopLevels = (): void => {
    if (levelTimer === 0) return;
    window.clearInterval(levelTimer);
    levelTimer = 0;
  };

  const tickAudio = (): void => {
    if (audioSources.length === 0) return;
    const frames: EngineAudioFrame[] = [];
    for (const source of audioSources) {
      const result = graph.readAudio(source, audioBands);
      frames.push({
        source: result.source,
        active: result.active,
        level: result.level,
        bands: result.bands,
      });
    }
    void send({ type: "audio.frame", frames });
  };

  const updateAudio = (): void => {
    if (audioTimer !== 0) return;
    audioTimer = window.setInterval(tickAudio, audioIntervalMs);
  };

  const stopAudio = (): void => {
    if (audioTimer === 0) return;
    window.clearInterval(audioTimer);
    audioTimer = 0;
  };

  const applyAudioCommand = (command: {
    sources: string[];
    bands: boolean;
    intervalMs: number;
  }): void => {
    const known = new Set<AudioSource>(["music", "noise", "mix", "master"]);
    const sources = command.sources.filter((source): source is AudioSource =>
      known.has(source as AudioSource),
    );
    const interval = Math.min(200, Math.max(50, command.intervalMs || 50));
    const restart = interval !== audioIntervalMs && audioTimer !== 0;
    audioSources = sources;
    audioBands = command.bands;
    audioIntervalMs = interval;

    if (sources.length === 0) {
      stopAudio();
      return;
    }
    try {
      graph.ensure();
    } catch {
      stopAudio();
      void send({
        type: "audio.status",
        available: false,
        reason: "not-supported",
      });
      return;
    }
    if (restart) {
      stopAudio();
    }
    updateAudio();
  };

  const dispose = (): void => {
    stopLevels();
    stopAudio();
    player.dispose();
    noise.dispose();
    graph.dispose();
  };

  const onDeviceChange = (): void => {
    if (reloading) return;
    reloading = true;
    // WebView2 的 AudioContext 不保证跟随默认输出设备；重载引擎页后由 Rust
    // 通过 ready + 全量 sync 恢复。设备监听不可用时用户仍可重开窗口恢复。
    window.location.reload();
  };
  navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);

  const handle = (command: EngineCommand): void => {
    switch (command.type) {
      case "player.load":
        void player.load({
          loadId: command.loadId,
          source: command.source,
          positionMs: command.positionMs,
          durationMs: command.durationMs,
          autoplay: command.autoplay,
        });
        return;
      case "player.play":
        void player.play();
        return;
      case "player.pause":
        player.pause();
        return;
      case "player.stop":
        player.stop();
        return;
      case "player.seek":
        player.seek(command.positionMs);
        return;
      case "player.volume":
        player.setVolume(command.volume, command.muted);
        return;
      case "output.volume":
        graph.setOutputVolume(command.volume, command.muted);
        return;
      case "noise.session.sync":
        noise.start();
        noise.sync(command);
        return;
      case "meters":
        if (command.player || command.noise) updateLevels();
        else stopLevels();
        return;
      case "audio.analyze":
        applyAudioCommand(command);
        return;
      case "engine.shutdown":
        dispose();
        return;
      default: {
        const exhaustive: never = command;
        void send({
          type: "error",
          scope: "player",
          code: "engine.unknown-command",
          message: String(exhaustive),
        });
      }
    }
  };

  await listen<EngineCommand>("media-engine-command", (event) => {
    handle(event.payload);
  });
  try {
    await invoke("media_engine_ready");
  } catch {
    // 引擎窗口的 capability 缺失时由宿主诊断；不抛到页面。
  }

  window.addEventListener(
    "pagehide",
    () => {
      navigator.mediaDevices?.removeEventListener?.(
        "devicechange",
        onDeviceChange,
      );
      dispose();
    },
    { once: true },
  );
}
