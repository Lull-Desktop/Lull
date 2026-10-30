/** 媒体呈现的纯决策函数，便于单测且不依赖 Tauri/React。 */
import type {
  MediaBackend,
  MediaCapabilities,
  MediaFit,
  MediaKind,
  MediaPosition,
} from "./types";

const IMAGE_EXTENSIONS = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
]);
const VIDEO_EXTENSIONS = new Set(["mp4", "m4v", "webm", "mov"]);

/** 从 asset URL 兜底推断素材类型；Rust 返回的 `kind` 优先。 */
export function mediaKindFromUrl(source: string): MediaKind | null {
  if (!source) return null;
  let path = source;
  try {
    path = new URL(source).pathname;
  } catch {
    // 相对路径或测试桩：按原串取扩展名。
  }
  try {
    path = decodeURIComponent(path);
  } catch {
    // 非法百分号序列：保留原串。
  }
  const dot = path.lastIndexOf(".");
  if (dot < 0) return null;
  const extension = path.slice(dot + 1).toLowerCase();
  if (VIDEO_EXTENSIONS.has(extension)) return "video";
  if (IMAGE_EXTENSIONS.has(extension)) return "image";
  return null;
}

export type NativeAttempt = {
  attempt: boolean;
  reason: string | null;
};

/**
 * 是否尝试原生 TextureStream。
 *
 * 只有 Rust 探测通过、并且当前页面真的有 `getTextureStream` 时才尝试；否则直接
 * HTML。原生尝试失败后调用方必须调用 `degradeMediaSession`，不能无限重试。
 */
export function decideNativeAttempt(
  capabilities: MediaCapabilities,
  hasGetTextureStream: boolean,
): NativeAttempt {
  if (!capabilities.nativeTextureStream) {
    return { attempt: false, reason: capabilities.reason };
  }
  if (!hasGetTextureStream) {
    return { attempt: false, reason: "当前 WebView2 不支持 getTextureStream" };
  }
  return { attempt: true, reason: null };
}

export function backendLabel(backend: MediaBackend): string {
  return backend === "native-texture" ? "原生纹理共享" : "HTML 视频回退";
}

export function mediaObjectFit(fit: MediaFit): "cover" | "contain" | "fill" {
  return fit;
}

export function mediaObjectPosition(position: MediaPosition): string {
  switch (position) {
    case "top":
      return "center top";
    case "bottom":
      return "center bottom";
    case "left":
      return "left center";
    case "right":
      return "right center";
    default:
      return "center center";
  }
}

export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value.toFixed(index === 0 ? 0 : 1)} ${units[index]}`;
}
