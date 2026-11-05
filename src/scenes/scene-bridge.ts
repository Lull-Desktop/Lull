/**
 * 外部场景宿主桥的线上协议。
 *
 * 与 `packages/scene-sdk` 的 `protocol.ts` 逐字段对应；改动这里必须同时改 SDK
 * 与 `packages/scene-sdk/src/client.test.ts` 的契约断言。
 *
 * 消息方向：
 * - 场景 → 宿主：`ready` / `log`
 * - 宿主 → 场景：`init` / `frame` / `visibility`
 */
import type {
  GameContext,
  GameEvent,
  GameLifecycleEvent,
  GameRenderState,
  GameSnapshot,
} from "@/lib/games";
import { SCENE_HOST_API, type SceneFrame } from "@/sdk/scene";

export const SCENE_BRIDGE_PROTOCOL = 1 as const;

/** 场景游戏桥与 Game SDK 共用的协议版本。 */
export const SCENE_GAME_PROTOCOL = 1 as const;

/** 场景迟迟不发 ready 时的诊断阈值；超时只记日志，不阻断壁纸渲染。 */
export const SCENE_READY_TIMEOUT_MS = 8000;

export type SceneHostMessage =
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "init";
      protocol: typeof SCENE_BRIDGE_PROTOCOL;
      hostApi: number;
      id: string;
      frame: SceneFrame;
      visible: boolean;
    }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "frame";
      frame: SceneFrame;
    }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "visibility";
      visible: boolean;
    };

export type ScenePluginMessage =
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "ready";
      protocol: typeof SCENE_BRIDGE_PROTOCOL;
    }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "log";
      level: "log" | "warn" | "error";
      message: string;
    };

export function sceneInitMessage(
  id: string,
  frame: SceneFrame,
  visible: boolean,
): SceneHostMessage {
  return {
    v: SCENE_BRIDGE_PROTOCOL,
    type: "init",
    protocol: SCENE_BRIDGE_PROTOCOL,
    hostApi: SCENE_HOST_API,
    id,
    frame,
    visible,
  };
}

export function sceneFrameMessage(frame: SceneFrame): SceneHostMessage {
  return { v: SCENE_BRIDGE_PROTOCOL, type: "frame", frame };
}

export function sceneVisibilityMessage(visible: boolean): SceneHostMessage {
  return { v: SCENE_BRIDGE_PROTOCOL, type: "visibility", visible };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// ---------------------------------------------------------------------------
// Scene ↔ Game 渲染桥（只读）
// ---------------------------------------------------------------------------

export type SceneGameHostMessage =
  | {
      v: typeof SCENE_GAME_PROTOCOL;
      type: "game.init";
      context: GameContext;
      snapshot: GameSnapshot | null;
    }
  | {
      v: typeof SCENE_GAME_PROTOCOL;
      type: "game.snapshot";
      snapshot: GameSnapshot;
    }
  | {
      v: typeof SCENE_GAME_PROTOCOL;
      type: "game.event";
      event: GameEvent;
    }
  | {
      v: typeof SCENE_GAME_PROTOCOL;
      type: "game.render";
      renderState: GameRenderState;
    }
  | {
      v: typeof SCENE_GAME_PROTOCOL;
      type: "game.lifecycle";
      event: GameLifecycleEvent;
    }
  | {
      v: typeof SCENE_GAME_PROTOCOL;
      type: "game.unavailable";
      reason?: string;
    };

export type SceneGamePluginMessage =
  | { v: typeof SCENE_GAME_PROTOCOL; type: "game.ready" }
  | { v: typeof SCENE_GAME_PROTOCOL; type: "game.requestSnapshot" }
  | {
      v: typeof SCENE_GAME_PROTOCOL;
      type: "game.reportError";
      code: string;
      message: string;
    }
  | { v: typeof SCENE_GAME_PROTOCOL; type: "game.detach" };

export function sceneGameInitMessage(
  context: GameContext,
  snapshot: GameSnapshot | null,
): SceneGameHostMessage {
  return { v: SCENE_GAME_PROTOCOL, type: "game.init", context, snapshot };
}

export function sceneGameSnapshotMessage(
  snapshot: GameSnapshot,
): SceneGameHostMessage {
  return { v: SCENE_GAME_PROTOCOL, type: "game.snapshot", snapshot };
}

export function sceneGameEventMessage(event: GameEvent): SceneGameHostMessage {
  return { v: SCENE_GAME_PROTOCOL, type: "game.event", event };
}

export function sceneGameRenderMessage(
  renderState: GameRenderState,
): SceneGameHostMessage {
  return { v: SCENE_GAME_PROTOCOL, type: "game.render", renderState };
}

export function sceneGameLifecycleMessage(
  event: GameLifecycleEvent,
): SceneGameHostMessage {
  return { v: SCENE_GAME_PROTOCOL, type: "game.lifecycle", event };
}

export function sceneGameUnavailableMessage(
  reason?: string,
): SceneGameHostMessage {
  return { v: SCENE_GAME_PROTOCOL, type: "game.unavailable", reason };
}

/** 场景 → 宿主：游戏渲染桥的握手/请求；来源窗口由调用方校验。 */
export function isSceneGamePluginMessage(
  value: unknown,
): value is SceneGamePluginMessage {
  if (!isRecord(value) || value.v !== SCENE_GAME_PROTOCOL) return false;
  switch (value.type) {
    case "game.ready":
    case "game.requestSnapshot":
    case "game.detach":
      return true;
    case "game.reportError":
      return (
        typeof value.code === "string" && typeof value.message === "string"
      );
    default:
      return false;
  }
}

/** 只接受协议内的消息；来源窗口校验由调用方负责（opaque origin 不能靠 origin）。 */
export function isScenePluginMessage(
  value: unknown,
): value is ScenePluginMessage {
  if (!isRecord(value) || value.v !== SCENE_BRIDGE_PROTOCOL) return false;
  if (value.type === "ready") {
    return value.protocol === SCENE_BRIDGE_PROTOCOL;
  }
  if (value.type === "log") {
    return (
      (value.level === "log" ||
        value.level === "warn" ||
        value.level === "error") &&
      typeof value.message === "string"
    );
  }
  return false;
}
