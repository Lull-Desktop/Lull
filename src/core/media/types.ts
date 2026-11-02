/**
 * 媒体 UI 与 Rust `media` 命令共享的类型。
 *
 * 类型以 Rust `serde(rename_all = "camelCase")` 的输出为准；不要在这里引入
 * media-pp / FFmpeg / D3D11 的概念，前端只认识“后端、状态、配置”。
 */

export type MediaBackend = "native-texture" | "html-video";

/** 素材类型：图片走 `<img>`，不创建媒体会话；视频走原生/HTML 播放。 */
export type MediaKind = "image" | "video";

export type MediaSessionState =
  | "starting"
  | "playing"
  | "paused"
  | "degraded"
  | "ended"
  | "error";

export type MediaFit = "cover" | "contain" | "fill";

export type MediaPosition = "center" | "top" | "bottom" | "left" | "right";

export type HardwareDecode = "auto" | "required" | "disabled";

export type MediaShare = "auto" | "shared" | "independent";

export type MediaConfig = {
  assetId: string | null;
  /** Rust 侧字段名是 `loop`，JSON 中必须保持这个拼写。 */
  loop: boolean;
  muted: boolean;
  rate: number;
  fit: MediaFit;
  position: MediaPosition;
  preferredFps: 24 | 30 | 60;
  hardwareDecode: HardwareDecode;
  share: MediaShare;
};

export const DEFAULT_MEDIA_CONFIG: MediaConfig = {
  assetId: null,
  loop: true,
  muted: true,
  rate: 1,
  fit: "cover",
  position: "center",
  preferredFps: 30,
  hardwareDecode: "auto",
  share: "auto",
};

export type MediaAsset = {
  id: string;
  name: string;
  /** image / video；由 Rust 素材库按扩展名判定。 */
  kind: MediaKind;
  sizeBytes: number;
  addedAt: number;
  /** 文件被移动/删除后为 false。 */
  available: boolean;
};

/** 批量导入里单条失败的信息：只有文件名与原因，不包含绝对路径。 */
export type MediaAssetImportFailure = {
  name: string;
  reason: string;
};

/** 批量导入结果：成功登记、重复跳过、失败明细。 */
export type MediaAssetImportResult = {
  added: MediaAsset[];
  skipped: number;
  failed: MediaAssetImportFailure[];
};

export type MediaCapabilities = {
  nativeTextureStream: boolean;
  hardwareDecode: boolean;
  reason: string | null;
  runtimeVersion: string | null;
  adapterLuid: number | null;
  htmlFallback: boolean;
};

export type MediaConfigView = {
  config: MediaConfig;
  asset: MediaAsset | null;
  assetUrl: string | null;
  capabilities: MediaCapabilities;
};

export type MediaOpenResult = {
  sessionId: string;
  backend: MediaBackend;
  assetUrl: string;
  state: MediaSessionState;
  reason: string | null;
};

export type MediaAttachResult = {
  backend: MediaBackend;
  streamId: string | null;
  assetUrl: string;
  state: MediaSessionState;
  reason: string | null;
};

export type MediaSurfaceView = {
  label: string;
  device: string | null;
  backend: MediaBackend;
  started: boolean;
  presented: number;
  dropped: number;
  lastMediaPtsUs: number | null;
  lastPresentedAtMs: number | null;
  adapterLuid: number | null;
};

export type MediaSessionView = {
  sessionId: string;
  sceneId: string;
  assetId: string;
  assetName: string | null;
  backend: MediaBackend;
  state: MediaSessionState;
  loopPlayback: boolean;
  muted: boolean;
  rate: number;
  preferredFps: number;
  hardwareDecode: string;
  share: string;
  decodePath: string | null;
  decoderInstances: number;
  positionMs: number;
  durationMs: number | null;
  lastError: string | null;
  surfaces: MediaSurfaceView[];
};

export type MediaStats = {
  sessions: number;
  nativeSessions: number;
  fallbackSessions: number;
  decoderInstances: number;
  cpuReadbackBytes: number;
  capabilities: MediaCapabilities;
  sessionViews: MediaSessionView[];
};

export type MediaDegradedEvent = {
  sessionId: string;
  assetUrl: string;
  reason: string;
};

/**
 * 原生 TextureStream 已经无法继续呈现：浏览器停止、渲染侧错误或适配器丢失。
 *
 * 这种流不会自己恢复，之后每一帧都会被丢弃。壁纸页收到后应立刻重挂纹理流，
 * 不能等 `requestVideoFrameCallback` 的 5 秒看门狗。
 */
export type MediaStreamStalledEvent = {
  sessionId: string;
  streamId: string;
  label: string;
  /** stopped / error / adapter-lost / not-compositing */
  reason: string;
  state: number;
  presented: number;
  dropped: number;
};

/** 壁纸窗每 5s 上报的 HTML 播放质量；原生路径由 media_stats 提供。 */
export type MediaPlaybackQuality = {
  label: string;
  total: number;
  dropped: number;
  readyState: number;
  at: number;
};

export type MediaConfigChangedEvent = Record<string, never>;

export function mediaConfigFromView(view: MediaConfigView): MediaConfig {
  return { ...DEFAULT_MEDIA_CONFIG, ...view.config };
}
