/**
 * 壁纸根路由：只负责解析 URL 哈希与监听变化，具体场景由 SceneHost 解析。
 * 该页面不调用任何 Tauri API，便于在纯浏览器中预览。
 */
"use client";

import { useEffect, useState } from "react";
import {
  DEFAULT_PARAMS,
  parseWallpaperParams,
  type WallpaperParams,
} from "@/core/wallpaper/params";
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

  useEffect(() => {
    const onHash = (): void => {
      setParams(parseWallpaperParams(window.location.hash));
    };
    window.addEventListener("hashchange", onHash);
    setReady(true);
    return () => window.removeEventListener("hashchange", onHash);
  }, []);

  if (!ready) {
    return (
      <div
        data-testid="wallpaper-root"
        className="fixed inset-0 overflow-hidden bg-[#07110f]"
      />
    );
  }

  return (
    <div
      data-testid="wallpaper-root"
      className="fixed inset-0 overflow-hidden bg-[#07110f]"
    >
      <SceneHost params={params} />
    </div>
  );
}
