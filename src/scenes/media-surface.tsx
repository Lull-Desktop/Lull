"use client";

/**
 * 场景侧视频表面。
 *
 * 原生路径：Rust 解码 → C++ TextureStream → `video.srcObject = MediaStream`。
 * 回退路径：Tauri asset protocol URL → `video.src`，由 Chromium 自行解码。
 *
 * 组件只负责“显示 + 生命周期”，不直接读文件、不传路径；token 由 Rust 在建窗时
 * 注入顶层帧，外部 iframe 拿不到。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import {
  attachMediaSession,
  degradeMediaSession,
  detachMediaSession,
  getMediaConfig,
  getWebView2TextureStream,
  isMediaDesktop,
  openMediaSession,
} from "@/core/media/media-api";
import {
  onMediaConfigChanged,
  onMediaDegraded,
  onMediaMasterVisible,
} from "@/core/media/media-events";
import {
  decideNativeAttempt,
  mediaObjectFit,
  mediaObjectPosition,
} from "@/core/media/media-state";
import type {
  MediaBackend,
  MediaConfig,
  MediaConfigView,
  MediaFit,
  MediaPosition,
} from "@/core/media/types";

const NATIVE_FIRST_FRAME_TIMEOUT_MS = 12_000;

type MediaSurfaceProps = {
  className?: string;
  /** 可选覆盖；默认使用 display.media 配置。 */
  fit?: MediaFit;
  position?: MediaPosition;
  onBackendChange?: (backend: MediaBackend | null) => void;
};

type SurfaceState = {
  view: MediaConfigView | null;
  config: MediaConfig | null;
  sessionId: string | null;
  backend: MediaBackend | null;
  error: string | null;
  loading: boolean;
};

const INITIAL_STATE: SurfaceState = {
  view: null,
  config: null,
  sessionId: null,
  backend: null,
  error: null,
  loading: true,
};

function applyVideoConfig(video: HTMLVideoElement, config: MediaConfig): void {
  video.loop = config.loop;
  video.muted = config.muted;
  video.playbackRate = config.rate;
}

export function MediaSurface({
  className,
  fit,
  position,
  onBackendChange,
}: MediaSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<string | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const [state, setState] = useState<SurfaceState>(INITIAL_STATE);
  const [reloadKey, setReloadKey] = useState(0);

  const clearNativeTimer = useCallback(() => {
    if (timeoutRef.current !== null) {
      window.clearTimeout(timeoutRef.current);
      timeoutRef.current = null;
    }
  }, []);

  const stopNativeTrack = useCallback(() => {
    trackRef.current?.stop();
    trackRef.current = null;
    const video = videoRef.current;
    if (video) {
      try {
        video.srcObject = null;
      } catch {
        // jsdom / 已销毁的 video
      }
    }
  }, []);

  const switchToHtmlFallback = useCallback(
    (url: string, config: MediaConfig, reason: string | null) => {
      if (disposedRef.current) return;
      const video = videoRef.current;
      clearNativeTimer();
      stopNativeTrack();
      if (!video) return;
      applyVideoConfig(video, config);
      video.srcObject = null;
      video.src = url;
      video.load();
      void video.play().catch(() => {
        // 自动播放被拒时保留首帧/渐变，不抛未捕获异常。
      });
      setState((current) => ({
        ...current,
        backend: "html-video",
        error: reason,
        loading: false,
      }));
      onBackendChange?.("html-video");
    },
    [clearNativeTimer, onBackendChange, stopNativeTrack],
  );

  const load = useCallback(async () => {
    if (!isMediaDesktop()) {
      setState((current) => ({
        ...current,
        loading: false,
        error: "浏览器预览没有媒体运行时",
      }));
      return;
    }
    setState((current) => ({ ...current, loading: true, error: null }));
    const view = await getMediaConfig();
    if (disposedRef.current) return;
    if (!view) {
      setState((current) => ({
        ...current,
        loading: false,
        error: "媒体配置不可用",
      }));
      return;
    }
    const config = view.config;
    setState((current) => ({ ...current, view, config }));
    if (!view.asset || !view.assetUrl || !view.asset.available) {
      setState((current) => ({ ...current, loading: false, error: null }));
      return;
    }

    const opened = await openMediaSession("lull.video");
    if (disposedRef.current) return;
    if (!opened) {
      switchToHtmlFallback(
        view.assetUrl,
        config,
        "原生会话不可用，已回退 HTML",
      );
      return;
    }
    sessionRef.current = opened.sessionId;
    setState((current) => ({ ...current, sessionId: opened.sessionId }));

    const attached = await attachMediaSession(opened.sessionId);
    if (disposedRef.current) return;
    const url = attached?.assetUrl ?? opened.assetUrl ?? view.assetUrl;
    const native = decideNativeAttempt(
      view.capabilities,
      typeof window.chrome?.webview?.getTextureStream === "function",
    );
    const canNative =
      native.attempt &&
      attached?.backend === "native-texture" &&
      typeof attached.streamId === "string";
    if (!canNative) {
      switchToHtmlFallback(url, config, attached?.reason ?? native.reason);
      return;
    }

    const video = videoRef.current;
    const stream = await getWebView2TextureStream(attached.streamId ?? "");
    if (disposedRef.current) return;
    if (!video || !stream) {
      await degradeMediaSession(
        opened.sessionId,
        "WebView2 TextureStream 首帧失败",
      );
      switchToHtmlFallback(url, config, "原生纹理不可用，已回退 HTML");
      return;
    }
    applyVideoConfig(video, config);
    trackRef.current = stream.getVideoTracks()[0] ?? null;
    video.srcObject = stream;
    setState((current) => ({
      ...current,
      backend: "native-texture",
      error: null,
      loading: false,
    }));
    onBackendChange?.("native-texture");
    void video.play().catch(() => {
      void degradeMediaSession(opened.sessionId, "原生视频自动播放失败").then(
        () => {
          switchToHtmlFallback(url, config, "自动播放失败，已回退 HTML");
        },
      );
    });
    clearNativeTimer();
    timeoutRef.current = window.setTimeout(() => {
      void degradeMediaSession(opened.sessionId, "12 秒内未收到原生首帧").then(
        () => {
          switchToHtmlFallback(url, config, "原生首帧超时，已回退 HTML");
        },
      );
    }, NATIVE_FIRST_FRAME_TIMEOUT_MS);
  }, [clearNativeTimer, onBackendChange, switchToHtmlFallback]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey intentionally restarts cleanup + load
  useEffect(() => {
    disposedRef.current = false;
    void load();
    return () => {
      disposedRef.current = true;
      clearNativeTimer();
      stopNativeTrack();
      const sessionId = sessionRef.current;
      sessionRef.current = null;
      if (sessionId) void detachMediaSession(sessionId);
      const video = videoRef.current;
      if (video) {
        try {
          video.pause();
          video.removeAttribute("src");
          video.load();
        } catch {
          // 窗口销毁/测试环境
        }
      }
    };
  }, [clearNativeTimer, load, reloadKey, stopNativeTrack]);

  // WebView 重载/场景切走时 React cleanup 不一定先跑完：pagehide 里同步释放
  // 轨道和 <video> 的 src，避免旧页面在卸载阶段继续解码。
  useEffect(() => {
    const release = (): void => {
      clearNativeTimer();
      stopNativeTrack();
      const video = videoRef.current;
      if (!video) return;
      try {
        video.pause();
        video.removeAttribute("src");
        video.load();
      } catch {
        // 已销毁的 WebView
      }
    };
    window.addEventListener("pagehide", release);
    return () => window.removeEventListener("pagehide", release);
  }, [clearNativeTimer, stopNativeTrack]);

  useEffect(() => {
    return onMediaConfigChanged(() => setReloadKey((key) => key + 1));
  }, []);

  useEffect(() => {
    return onMediaDegraded((event) => {
      const config = state.config;
      if (!config) return;
      if (sessionRef.current && event.sessionId !== sessionRef.current) return;
      switchToHtmlFallback(event.assetUrl, config, event.reason);
    });
  }, [state.config, switchToHtmlFallback]);

  useEffect(() => {
    return onMediaMasterVisible((visible) => {
      const video = videoRef.current;
      if (!video) return;
      if (!visible) {
        video.pause();
        return;
      }
      if (video.srcObject || video.getAttribute("src")) {
        void video.play().catch(() => {});
      }
    });
  }, []);

  const config = state.config;
  const resolvedFit = fit ?? config?.fit ?? "cover";
  const resolvedPosition = position ?? config?.position ?? "center";

  return (
    <div
      className={className}
      data-testid="media-surface"
      data-backend={state.backend ?? "idle"}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        backgroundColor: "#050a10",
      }}
      aria-hidden="true"
    >
      <video
        ref={videoRef}
        data-testid="media-video"
        muted
        playsInline
        preload="auto"
        disablePictureInPicture
        controls={false}
        tabIndex={-1}
        onLoadedMetadata={clearNativeTimer}
        onLoadedData={clearNativeTimer}
        onResize={clearNativeTimer}
        style={{
          width: "100%",
          height: "100%",
          objectFit: mediaObjectFit(resolvedFit),
          objectPosition: mediaObjectPosition(resolvedPosition),
          pointerEvents: "none",
          display: "block",
        }}
      />
    </div>
  );
}
