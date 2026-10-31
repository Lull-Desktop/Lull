/**
 * 媒体 IPC 封装。
 *
 * - 浏览器预览 / Vitest 下所有调用降级为空值，不产生未捕获 IPC rejection；
 * - 壁纸窗口带顶层帧 token；设置窗口不带 token（Rust 侧按 label 区分权限）；
 * - 这里只传 assetId/sessionId/config，不传文件路径或显示器标识。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import {
  DEFAULT_MEDIA_CONFIG,
  type MediaAsset,
  type MediaAttachResult,
  type MediaConfig,
  type MediaConfigView,
  type MediaOpenResult,
  type MediaStats,
} from "./types";

export function isMediaDesktop(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/** 壁纸顶层页面由 Rust 注入；外部 iframe 不能读取父 DOM，因此拿不到它。 */
export function readMediaToken(): string | undefined {
  if (typeof window === "undefined") return undefined;
  const token = window.__LULL_MEDIA_TOKEN__;
  return typeof token === "string" && token.length > 0 ? token : undefined;
}

function withToken<T extends Record<string, unknown>>(
  args: T,
): T & { token?: string } {
  const token = readMediaToken();
  return token ? { ...args, token } : args;
}

export async function getMediaConfig(): Promise<MediaConfigView | null> {
  if (!isMediaDesktop()) return null;
  try {
    return await invoke<MediaConfigView>("media_config_get", withToken({}));
  } catch {
    return null;
  }
}

export async function listMediaAssets(): Promise<MediaAsset[]> {
  if (!isMediaDesktop()) return [];
  try {
    const assets = await invoke<MediaAsset[]>("media_assets");
    return Array.isArray(assets) ? assets : [];
  } catch {
    return [];
  }
}

export async function pickMediaAsset(): Promise<MediaAsset | null> {
  if (!isMediaDesktop()) return null;
  return invoke<MediaAsset | null>("media_asset_pick");
}

export async function removeMediaAsset(id: string): Promise<void> {
  if (!isMediaDesktop()) return;
  await invoke("media_asset_remove", { id });
}

export async function setMediaConfig(
  config: MediaConfig,
): Promise<MediaConfigView> {
  const view = await invoke<MediaConfigView>("media_config_set", { config });
  return view;
}

export async function activateMediaAsset(
  assetId: string,
): Promise<MediaConfigView> {
  return invoke<MediaConfigView>("media_activate", { assetId });
}

export async function openMediaSession(
  sceneId = "lull.video",
): Promise<MediaOpenResult | null> {
  if (!isMediaDesktop()) return null;
  try {
    return await invoke<MediaOpenResult>("media_open", withToken({ sceneId }));
  } catch {
    return null;
  }
}

export async function attachMediaSession(
  sessionId: string,
): Promise<MediaAttachResult | null> {
  if (!isMediaDesktop()) return null;
  try {
    return await invoke<MediaAttachResult>(
      "media_attach",
      withToken({
        sessionId,
        origin: window.location.origin,
      }),
    );
  } catch {
    return null;
  }
}

export async function detachMediaSession(
  sessionId: string,
  streamId?: string | null,
): Promise<void> {
  if (!isMediaDesktop()) return;
  try {
    await invoke(
      "media_detach",
      withToken({ sessionId, streamId: streamId ?? null }),
    );
  } catch {
    // 页面卸载/窗口销毁竞态：detach 失败不影响关闭流程。
  }
}

export async function degradeMediaSession(
  sessionId: string,
  reason: string,
): Promise<MediaAttachResult | null> {
  if (!isMediaDesktop()) return null;
  try {
    return await invoke<MediaAttachResult>(
      "media_degrade",
      withToken({ sessionId, reason }),
    );
  } catch {
    return null;
  }
}

export async function playMediaSession(sessionId: string): Promise<void> {
  await invoke("media_play", { sessionId });
}

export async function pauseMediaSession(sessionId: string): Promise<void> {
  await invoke("media_pause", { sessionId });
}

export async function seekMediaSession(
  sessionId: string,
  positionMs: number,
): Promise<void> {
  await invoke("media_seek", { sessionId, positionMs });
}

/** 设置页「重新同步播放」：所有会话 seek 到同一点，并广播给 HTML 壁纸页。 */
export async function resyncMediaPlayback(positionMs = 0): Promise<number> {
  if (!isMediaDesktop()) return 0;
  return invoke<number>("media_resync", { positionMs });
}

export async function setMediaLoop(
  sessionId: string,
  enabled: boolean,
): Promise<void> {
  await invoke("media_set_loop", { sessionId, enabled });
}

export async function getMediaStats(): Promise<MediaStats | null> {
  if (!isMediaDesktop()) return null;
  try {
    return await invoke<MediaStats>("media_stats");
  } catch {
    return null;
  }
}

/**
 * WebView2 TextureStream 的 JS 入口。缺失/拒绝时返回 null，由调用方切 HTML。
 * 原生后端未启用时 Rust 不会返回 streamId，因此这里通常不会被调用。
 */
export async function getWebView2TextureStream(
  streamId: string,
): Promise<MediaStream | null> {
  const webview = window.chrome?.webview;
  const getStream = webview?.getTextureStream;
  if (!webview || typeof getStream !== "function") return null;
  try {
    return await getStream.call(webview, streamId);
  } catch {
    return null;
  }
}

export { DEFAULT_MEDIA_CONFIG };
