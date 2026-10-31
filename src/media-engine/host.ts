/**
 * 隐藏音频引擎入口：接收宿主命令、驱动 PlayerEngine/NoiseEngine，并上报事件。
 *
 * 页面不渲染任何 UI；Rust 负责业务状态与权限，这里只负责“实际发声”。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { NoiseEngine } from "./noise-engine";
import { PlayerEngine } from "./player-engine";
import type { EngineCommand, EngineEvent } from "./protocol";

let started = false;

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

  const player = new PlayerEngine((event) => {
    void send(event);
  });
  const noise = new NoiseEngine();
  let levelTimer = 0;

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
      case "noise.sync":
        void noise.start();
        noise.sync(
          command.active,
          command.master,
          command.muted,
          command.layers,
        );
        return;
      case "meters":
        if (command.player || command.noise) updateLevels();
        else stopLevels();
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
      player.dispose();
      noise.dispose();
      stopLevels();
    },
    { once: true },
  );
}
