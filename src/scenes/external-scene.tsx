"use client";

/**
 * 外部场景容器：静态包继续用空 sandbox；声明 `wallpaper.script` 的包改用
 * `allow-scripts` + postMessage 桥，把 SceneFrame（参数、几何、同步相位）
 * 推给 `@lull/scene-sdk`。
 *
 * 安全边界：
 * - iframe 不带 allow-same-origin，脚本拿不到宿主 DOM / 存储；
 * - 资源协议按文档下发 nonce CSP，默认禁止远程连接；
 * - 宿主只接受 `event.source === iframe.contentWindow` 的消息。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type SceneCatalogEntry,
  type SceneFrame,
  sceneRunsScript,
} from "@/sdk/scene";
import {
  isScenePluginMessage,
  SCENE_READY_TIMEOUT_MS,
  type SceneHostMessage,
  sceneFrameMessage,
  sceneInitMessage,
  sceneVisibilityMessage,
} from "./scene-bridge";

type ExternalSceneProps = {
  entry: SceneCatalogEntry;
  frame: SceneFrame;
  /** 内容完成首次绘制后回调；静态包用 onLoad，脚本包等 scene bridge 的 ready。 */
  onReady?: () => void;
};

/** 外部 static 包不执行脚本，也不接收参数；保持首版的安全边界。 */
function StaticScene({
  entry,
  src,
  onReady,
}: {
  entry: SceneCatalogEntry;
  src: string;
  onReady?: () => void;
}) {
  return (
    <iframe
      data-testid="external-scene"
      data-runtime="static"
      title={entry.manifest.name}
      src={src}
      sandbox=""
      referrerPolicy="no-referrer"
      className="absolute inset-0 h-full w-full border-0"
      onLoad={onReady}
    />
  );
}

/** iframe 的实际绘制区域；span 下它等于画布，而不是壁纸窗口。 */
function measureViewport(
  frame: HTMLIFrameElement | null,
  fallback: SceneFrame["viewport"],
): SceneFrame["viewport"] {
  if (!frame) return fallback;
  const w = Math.round(frame.clientWidth);
  const h = Math.round(frame.clientHeight);
  if (w <= 0 || h <= 0) return fallback;
  return {
    w,
    h,
    dpr:
      typeof window === "undefined"
        ? fallback.dpr
        : window.devicePixelRatio || 1,
  };
}

function frameForIframe(
  frame: SceneFrame,
  iframe: HTMLIFrameElement | null,
): SceneFrame {
  return { ...frame, viewport: measureViewport(iframe, frame.viewport) };
}

function ScriptedScene({
  entry,
  frame,
  src,
  onReady,
}: ExternalSceneProps & { src: string }) {
  const iframeRef = useRef<HTMLIFrameElement>(null);
  const frameRef = useRef(frame);
  const readyRef = useRef(false);
  const onReadyRef = useRef(onReady);
  const [ready, setReady] = useState(false);

  // 事件回调里读到的是最新一帧 / 最新回调，而不是注册监听时的闭包。
  frameRef.current = frame;
  onReadyRef.current = onReady;

  const send = useCallback((message: SceneHostMessage): void => {
    iframeRef.current?.contentWindow?.postMessage(message, "*");
  }, []);

  const sendInit = useCallback((): void => {
    const visible =
      typeof document === "undefined" || document.visibilityState === "visible";
    send(
      sceneInitMessage(
        entry.manifest.id,
        frameForIframe(frameRef.current, iframeRef.current),
        visible,
      ),
    );
    send(sceneVisibilityMessage(visible));
  }, [entry.manifest.id, send]);

  const handleLoad = useCallback((): void => {
    // iframe 重新加载后旧页面的 ready 失效；先发 init，等新页面回 ready。
    readyRef.current = false;
    setReady(false);
    sendInit();
  }, [sendInit]);

  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe) return;
    const onMessage = (event: MessageEvent): void => {
      // opaque origin 下 event.origin 是 "null"，只能靠 source 校验。
      if (event.source !== iframe.contentWindow) return;
      if (!isScenePluginMessage(event.data)) return;
      const message = event.data;
      if (message.type === "ready") {
        readyRef.current = true;
        setReady(true);
        sendInit();
        onReadyRef.current?.();
        return;
      }
      const level =
        message.level === "error"
          ? "error"
          : message.level === "warn"
            ? "warn"
            : "log";
      console[level](`[scene:${entry.manifest.id}]`, message.message);
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [entry.manifest.id, sendInit]);

  // frame 变化（参数 / 布局 / 窗口尺寸）时推给场景；ready 之前的更新跳过，
  // 首帧由 ready 后的 init 补上。
  useEffect(() => {
    if (!readyRef.current) return;
    send(sceneFrameMessage(frameForIframe(frame, iframeRef.current)));
  }, [frame, send]);

  useEffect(() => {
    const sendVisibility = (): void => {
      if (!readyRef.current) return;
      send(sceneVisibilityMessage(document.visibilityState === "visible"));
    };
    document.addEventListener("visibilitychange", sendVisibility);
    return () =>
      document.removeEventListener("visibilitychange", sendVisibility);
  }, [send]);

  // span / mirror 切换时 iframe 容器尺寸会变，但未必触发 window resize。
  useEffect(() => {
    const iframe = iframeRef.current;
    if (!iframe || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (!readyRef.current) return;
      send(sceneFrameMessage(frameForIframe(frameRef.current, iframe)));
    });
    observer.observe(iframe);
    return () => observer.disconnect();
  }, [send]);

  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (readyRef.current) return;
      console.warn(
        `[scene:${entry.manifest.id}] 未在 ${SCENE_READY_TIMEOUT_MS / 1000}s 内响应场景桥；` +
          "参数与同步不会生效。请确认场景使用了 @lull/scene-sdk。",
      );
    }, SCENE_READY_TIMEOUT_MS);
    return () => window.clearTimeout(timer);
  }, [entry.manifest.id]);

  return (
    <iframe
      ref={iframeRef}
      data-testid="external-scene"
      data-runtime="scripted"
      data-bridge-ready={ready ? "true" : "false"}
      title={entry.manifest.name}
      src={src}
      sandbox="allow-scripts"
      referrerPolicy="no-referrer"
      className="absolute inset-0 h-full w-full border-0"
      onLoad={handleLoad}
    />
  );
}

export function ExternalScene({ entry, frame, onReady }: ExternalSceneProps) {
  const src = entry.entryUrl;
  if (!src) return null;
  if (!sceneRunsScript(entry.manifest)) {
    return <StaticScene entry={entry} src={src} onReady={onReady} />;
  }
  return (
    <ScriptedScene entry={entry} frame={frame} src={src} onReady={onReady} />
  );
}
