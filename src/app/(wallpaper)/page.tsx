/**
 * 壁纸根路由：只负责解析 URL 哈希与监听变化，具体场景由 SceneHost 解析。
 * 该页面不调用任何 Tauri API，便于在纯浏览器中预览。
 */
"use client";

import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_PARAMS,
  parseWallpaperParams,
  type WallpaperParams,
} from "@/core/wallpaper/params";
import { BootVeil } from "@/scenes/boot-veil";
import { SceneHost } from "@/scenes/host";

function readParams(): WallpaperParams {
  if (typeof window === "undefined") {
    return DEFAULT_PARAMS;
  }
  return parseWallpaperParams(window.location.hash);
}

export default function WallpaperHome() {
  const [params, setParams] = useState<WallpaperParams>(readParams);
  // SSR/首帧后才渲染场景：Date.now()/dpr 只有客户端有值，避免 hydration 不一致。
  const [ready, setReady] = useState(false);
  // 启动幕至少停留 700ms，避免场景太快就绪时"闪一下品牌字"；
  // 场景真正绘制后才揭幕，另设 3s 兜底，目录/外部场景异常时不会一直盖着。
  const [sceneReady, setSceneReady] = useState(false);
  const [minElapsed, setMinElapsed] = useState(false);
  const [booted, setBooted] = useState(false);
  const handleSceneReady = useCallback(() => setSceneReady(true), []);

  useEffect(() => {
    const onHash = (): void => {
      setParams(parseWallpaperParams(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    setReady(true);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setMinElapsed(true), 700);
    return () => window.clearTimeout(timer);
  }, []);

  useEffect(() => {
    if (sceneReady && minElapsed) setBooted(true);
  }, [sceneReady, minElapsed]);

  useEffect(() => {
    const timer = window.setTimeout(() => setBooted(true), 3000);
    return () => window.clearTimeout(timer);
  }, []);

  return (
    <div
      data-testid="wallpaper-root"
      className="fixed inset-0 overflow-hidden bg-[#07110f]"
    >
      {/* 启动幕始终是第一个子节点：ready 从 false 变 true 时 React 复用同一个
          实例，淡出过渡不会因重挂载而重置；z-index 保证它仍盖在场景之上。 */}
      <BootVeil hidden={booted} />
      {ready && <SceneHost params={params} onReady={handleSceneReady} />}
    </div>
  );
}
