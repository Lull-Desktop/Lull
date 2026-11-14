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
import {
  type AudioFrame,
  type AudioSnapshot,
  type AudioStatus,
  type AudioSubscribeOptions,
  isAudioSubscribeOptions,
  SCENE_HOST_API,
  type SceneFrame,
  type ScenePointer,
} from "@/sdk/scene";

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
    }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "pointer";
      pointer: ScenePointer;
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

/**
 * 鼠标位置消息：只承载移动状态与本地坐标。
 *
 * 桥协议里没有 click / dblclick / mousedown 等类型；宿主也从不读取按键状态，
 * 因此点击操作不会被转发，也不会影响桌面输入。
 */
export function scenePointerMessage(pointer: ScenePointer): SceneHostMessage {
  return { v: SCENE_BRIDGE_PROTOCOL, type: "pointer", pointer };
}

// ---------------------------------------------------------------------------
// 音频响应桥（wallpaper.audio）
// ---------------------------------------------------------------------------

/**
 * 宿主 → 场景的音频消息。
 *
 * 音频使用独立通道而不是塞进 `SceneFrame`：更新频率（20Hz）与帧/参数不同，
 * 且包含多个独立来源。`audio.frame` 每个 tick 一条，批量携带多个来源。
 */
export type SceneAudioHostMessage =
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "audio.init";
      snapshot: AudioSnapshot;
      status: AudioStatus;
    }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "audio.frame";
      frames: AudioFrame[];
    }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "audio.status";
      status: AudioStatus;
    }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "audio.snapshot";
      requestId: string;
      snapshot: AudioSnapshot;
    };

/** 场景 → 宿主的音频消息；来源窗口由 `ExternalScene` 校验。 */
export type SceneAudioPluginMessage =
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "audio.subscribe";
      options: AudioSubscribeOptions;
    }
  | { v: typeof SCENE_BRIDGE_PROTOCOL; type: "audio.unsubscribe" }
  | {
      v: typeof SCENE_BRIDGE_PROTOCOL;
      type: "audio.requestSnapshot";
      requestId: string;
    };

export function sceneAudioInitMessage(
  snapshot: AudioSnapshot,
  status: AudioStatus,
): SceneAudioHostMessage {
  return { v: SCENE_BRIDGE_PROTOCOL, type: "audio.init", snapshot, status };
}

export function sceneAudioFrameMessage(
  frames: AudioFrame[],
): SceneAudioHostMessage {
  return { v: SCENE_BRIDGE_PROTOCOL, type: "audio.frame", frames };
}

export function sceneAudioStatusMessage(
  status: AudioStatus,
): SceneAudioHostMessage {
  return { v: SCENE_BRIDGE_PROTOCOL, type: "audio.status", status };
}

export function sceneAudioSnapshotMessage(
  requestId: string,
  snapshot: AudioSnapshot,
): SceneAudioHostMessage {
  return {
    v: SCENE_BRIDGE_PROTOCOL,
    type: "audio.snapshot",
    requestId,
    snapshot,
  };
}

function isRequestId(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

/** 音频请求必须来自脚本桥场景；能力授权由调用方按 Manifest 判断。 */
export function isSceneAudioPluginMessage(
  value: unknown,
): value is SceneAudioPluginMessage {
  if (!isRecord(value) || value.v !== SCENE_BRIDGE_PROTOCOL) return false;
  if (value.type === "audio.subscribe") {
    return isAudioSubscribeOptions(value.options);
  }
  if (value.type === "audio.unsubscribe") return true;
  if (value.type === "audio.requestSnapshot") {
    return isRequestId(value.requestId);
  }
  return false;
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
