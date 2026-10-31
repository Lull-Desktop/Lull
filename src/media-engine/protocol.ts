import type { AmbientPreset } from "./preset";

export type PlaybackSource =
  | { kind: "ambient"; preset: AmbientPreset }
  | { kind: "asset"; url: string };

export type NoiseLayer = {
  soundId: string;
  enabled: boolean;
  volume: number;
};

export type EngineCommand =
  | {
      v: 1;
      type: "player.load";
      loadId: string;
      source: PlaybackSource;
      positionMs: number;
      durationMs: number | null;
      autoplay: boolean;
    }
  | { v: 1; type: "player.play" }
  | { v: 1; type: "player.pause" }
  | { v: 1; type: "player.stop" }
  | { v: 1; type: "player.seek"; positionMs: number }
  | { v: 1; type: "player.volume"; volume: number; muted: boolean }
  | {
      v: 1;
      type: "noise.sync";
      active: boolean;
      master: number;
      muted: boolean;
      layers: NoiseLayer[];
    }
  | {
      v: 1;
      type: "meters";
      player: boolean;
      noise: boolean;
      intervalMs: number;
    };

export type PlayerStatus = "playing" | "paused" | "ended" | "error";

export type EngineEvent =
  | { type: "ready"; instanceId: string }
  | { type: "player.loaded"; loadId: string; durationMs: number | null }
  | {
      type: "player.state";
      loadId: string;
      status: PlayerStatus;
      positionMs: number;
      durationMs: number | null;
      error?: { code: string; message: string };
    }
  | { type: "player.progress"; loadId: string; positionMs: number }
  | { type: "levels"; player: number; noise: number }
  | {
      type: "error";
      scope: "player" | "noise";
      code: string;
      message: string;
    };
