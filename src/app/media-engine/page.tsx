/**
 * 隐藏音频引擎窗口：不渲染 UI，只启动 Web Audio 宿主。
 *
 * 由 Rust `media/playback/engine.rs` 懒创建，label 固定为 `media-engine`；
 * 不是用户可打开的页面，也不属于 Widget 系统。
 */
"use client";

import { useEffect } from "react";
import { startMediaEngineHost } from "@/media-engine/host";

export default function MediaEnginePage() {
  useEffect(() => {
    void startMediaEngineHost();
  }, []);
  return null;
}
