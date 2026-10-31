"use client";

import {
  createMediaClient,
  isTauriRuntime,
  type LullMediaClient,
} from "@lull/media-sdk";

let singleton: LullMediaClient | null = null;

/**
 * 官方窗口的 Media SDK 单例。浏览器预览/单测返回 null，组件保留无音频的
 * 纯 UI 回退；Tauri 窗口首次调用时创建客户端。
 */
export function getMediaClient(): LullMediaClient | null {
  if (!isTauriRuntime()) return null;
  if (!singleton) singleton = createMediaClient();
  return singleton;
}
