/** 媒体呈现的纯决策函数，便于单测且不依赖 Tauri/React。 */
import type {
  MediaBackend,
  MediaCapabilities,
  MediaFit,
  MediaPosition,
} from "./types";

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
