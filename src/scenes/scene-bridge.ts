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
import { SCENE_HOST_API, type SceneFrame } from "@/sdk/scene";

export const SCENE_BRIDGE_PROTOCOL = 1 as const;

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
