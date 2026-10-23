/**
 * Lull Scene Host 线上协议 v1。
 *
 * 与宿主 `src/scenes/scene-bridge.ts` 逐字段对应；改字段必须同时改宿主与
 * `client.test.ts` 的契约断言，否则已发布的场景包会静默失效。
 */

export const SCENE_PROTOCOL = 1 as const;

export type SceneParamValue = string | number | boolean;

export type SceneRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

export type SceneDisplayMode = "mirror" | "independent" | "span";
export type SceneLayout = "viewport" | "canvas";

export type SceneViewport = {
  w: number;
  h: number;
  dpr: number;
};

export type SceneSync = {
  enabled: boolean;
  epochMs: number;
};

export type ScenePerformanceHints = {
  tier: "low" | "medium" | "high";
  targetFps?: number;
};

/** 宿主每帧/每次参数变化下发的只读画面信息。 */
export type SceneFrame = {
  mode: SceneDisplayMode;
  layout: SceneLayout;
  sync: SceneSync;
  viewport: SceneViewport;
  canvas: SceneRect | null;
  view: SceneRect | null;
  dpr: number;
  params: Record<string, SceneParamValue>;
  reducedMotion: boolean;
  performance: ScenePerformanceHints | null;
};

export type SceneInitMessage = {
  v: typeof SCENE_PROTOCOL;
  type: "init";
  protocol: typeof SCENE_PROTOCOL;
  hostApi: number;
  id: string;
  frame: SceneFrame;
  visible: boolean;
};

export type SceneFrameMessage = {
  v: typeof SCENE_PROTOCOL;
  type: "frame";
  frame: SceneFrame;
};

export type SceneVisibilityMessage = {
  v: typeof SCENE_PROTOCOL;
  type: "visibility";
  visible: boolean;
};

export type SceneHostMessage =
  | SceneInitMessage
  | SceneFrameMessage
  | SceneVisibilityMessage;

export type SceneReadyMessage = {
  v: typeof SCENE_PROTOCOL;
  type: "ready";
  protocol: typeof SCENE_PROTOCOL;
};

export type SceneLogMessage = {
  v: typeof SCENE_PROTOCOL;
  type: "log";
  level: "log" | "warn" | "error";
  message: string;
};

export type SceneClientMessage = SceneReadyMessage | SceneLogMessage;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isRect(value: unknown): value is SceneRect {
  return (
    isRecord(value) &&
    typeof value.x === "number" &&
    typeof value.y === "number" &&
    typeof value.w === "number" &&
    typeof value.h === "number"
  );
}

/** 只做协议层校验；未知字段忽略，方便宿主向前兼容地追加信息。 */
export function isSceneFrame(value: unknown): value is SceneFrame {
  if (!isRecord(value)) return false;
  if (
    value.mode !== "mirror" &&
    value.mode !== "independent" &&
    value.mode !== "span"
  ) {
    return false;
  }
  if (value.layout !== "viewport" && value.layout !== "canvas") return false;
  if (!isRecord(value.sync) || typeof value.sync.enabled !== "boolean") {
    return false;
  }
  if (!isRecord(value.viewport)) return false;
  if (
    typeof value.viewport.w !== "number" ||
    typeof value.viewport.h !== "number" ||
    typeof value.viewport.dpr !== "number"
  ) {
    return false;
  }
  if (value.canvas !== null && !isRect(value.canvas)) return false;
  if (value.view !== null && !isRect(value.view)) return false;
  if (typeof value.dpr !== "number") return false;
  if (!isRecord(value.params)) return false;
  if (typeof value.reducedMotion !== "boolean") return false;
  return true;
}

export function isSceneHostMessage(value: unknown): value is SceneHostMessage {
  if (!isRecord(value) || value.v !== SCENE_PROTOCOL) return false;
  if (value.type === "init") {
    return (
      value.protocol === SCENE_PROTOCOL &&
      typeof value.hostApi === "number" &&
      typeof value.id === "string" &&
      typeof value.visible === "boolean" &&
      isSceneFrame(value.frame)
    );
  }
  if (value.type === "frame") return isSceneFrame(value.frame);
  if (value.type === "visibility") return typeof value.visible === "boolean";
  return false;
}
