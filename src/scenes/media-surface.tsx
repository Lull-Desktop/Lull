"use client";

/**
 * 场景侧媒体表面。
 *
 * 原生路径：Rust 解码 → C++ TextureStream → `video.srcObject = MediaStream`。
 * 回退路径：Tauri asset protocol URL → `video.src`，由 Chromium 自行解码；
 * 图片素材直接 `img.src`，不创建媒体会话。
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
import { reportMediaQuality } from "@/core/media/media-quality";
import {
  decideNativeAttempt,
  mediaKindFromUrl,
  mediaObjectFit,
  mediaObjectPosition,
} from "@/core/media/media-state";
import { alignVideoPhase } from "@/core/media/phase";
import type {
  MediaBackend,
  MediaConfig,
  MediaConfigView,
  MediaFit,
  MediaKind,
  MediaPosition,
} from "@/core/media/types";

const NATIVE_FIRST_FRAME_TIMEOUT_MS = 12_000;
/** 起播/恢复时的对齐容差：偏差小于它就不 seek（seek 要 flush 解码器）。 */
const ALIGN_TOLERANCE_SEC = 0.5;
/** 稳态漂移兜底：间隔足够长、容差足够大，正常播放不会触发。 */
const DRIFT_CHECK_MS = 60_000;
const DRIFT_TOLERANCE_SEC = 2;
/** 播放质量采样间隔；设置页据此显示丢帧率。 */
const QUALITY_SAMPLE_MS = 5_000;

type MediaSurfaceProps = {
  className?: string;
  /** 可选覆盖；默认使用 display.media 配置。 */
  fit?: MediaFit;
  position?: MediaPosition;
  /** 宿主是否要求按绝对时间对齐相位；仅 HTML 视频路径消费。 */
  syncEnabled?: boolean;
  onBackendChange?: (backend: MediaBackend | null) => void;
};

type SurfaceState = {
  view: MediaConfigView | null;
  config: MediaConfig | null;
  kind: MediaKind | null;
  sessionId: string | null;
  backend: MediaBackend | null;
  error: string | null;
  loading: boolean;
};

const INITIAL_STATE: SurfaceState = {
  view: null,
  config: null,
  kind: null,
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
  syncEnabled = false,
  onBackendChange,
}: MediaSurfaceProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const sessionRef = useRef<string | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  const [state, setState] = useState<SurfaceState>(INITIAL_STATE);
  const [reloadKey, setReloadKey] = useState(0);

  // 事件回调在注册时捕获不到最新 props/config；用 ref 读取“当前值”。
  const configRef = useRef<MediaConfig | null>(null);
  configRef.current = state.config;
  const syncRef = useRef(syncEnabled);
  syncRef.current = syncEnabled;

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

  /**
   * HTML 起播：metadata 就绪后按墙钟对齐一次，再 play。
   *
   * 不在 `load()` 后立刻 play：4K 下先 seek 再播可以避免“从 0 播几百毫秒再跳”
   * 的可见回退；偏差在容差内则不 seek，保留首帧。
   */
  const startHtmlPlayback = useCallback(
    (video: HTMLVideoElement, config: MediaConfig): void => {
      const begin = (): void => {
        if (syncRef.current && config.loop) {
          alignVideoPhase(video, ALIGN_TOLERANCE_SEC, config.rate);
        }
        void video.play().catch(() => {
          // 自动播放被拒时保留首帧/渐变，不抛未捕获异常。
        });
      };
      if (video.readyState >= HTMLMediaElement.HAVE_METADATA) {
        begin();
      } else {
        video.addEventListener("loadedmetadata", begin, { once: true });
      }
    },
    [],
  );

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
      startHtmlPlayback(video, config);
      setState((current) => ({
        ...current,
        backend: "html-video",
        error: reason,
        loading: false,
      }));
      onBackendChange?.("html-video");
    },
    [clearNativeTimer, onBackendChange, startHtmlPlayback, stopNativeTrack],
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
    setState((current) => ({
      ...current,
      loading: true,
      error: null,
      backend: null,
      sessionId: null,
    }));
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
    const kind =
      view.asset?.kind ??
      (view.assetUrl ? mediaKindFromUrl(view.assetUrl) : null) ??
      "video";
    setState((current) => ({ ...current, view, config, kind }));
    if (!view.asset || !view.assetUrl || !view.asset.available) {
      setState((current) => ({ ...current, loading: false, error: null }));
      return;
    }

    // 图片是静态资源：不建 Session、不尝试原生、不占解码器。
    if (kind === "image") {
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
      if (!config || state.kind === "image") return;
      if (sessionRef.current && event.sessionId !== sessionRef.current) return;
      switchToHtmlFallback(event.assetUrl, config, event.reason);
    });
  }, [state.config, state.kind, switchToHtmlFallback]);

  // 隐藏即暂停；恢复时重新按墙钟对齐一次再播。原生 srcObject 是实时流，
  // 不能 seek，只处理 HTML 的 src 路径。
  useEffect(() => {
    return onMediaMasterVisible((visible) => {
      const video = videoRef.current;
      if (!video) return;
      if (!visible) {
        video.pause();
        return;
      }
      const config = configRef.current;
      const isHtml = !video.srcObject && Boolean(video.getAttribute("src"));
      if (isHtml && syncRef.current && config?.loop) {
        alignVideoPhase(video, DRIFT_TOLERANCE_SEC, config.rate);
      }
      if (video.srcObject || video.getAttribute("src")) {
        void video.play().catch(() => {});
      }
    });
  }, []);

  // 长播漂移兜底：正常播放不会触发；只纠正 HTML 的 src 路径，原生流不 seek。
  useEffect(() => {
    if (!syncEnabled) return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      const config = configRef.current;
      if (!video || !config?.loop || video.srcObject) return;
      if (video.paused || video.seeking) return;
      if (video.readyState < HTMLMediaElement.HAVE_FUTURE_DATA) return;
      alignVideoPhase(video, DRIFT_TOLERANCE_SEC, config.rate);
    }, DRIFT_CHECK_MS);
    return () => window.clearInterval(timer);
  }, [syncEnabled]);

  // HTML 播放质量采样：设置页据此验收多屏 4K 是否丢帧。
  // 原生 MediaStream 的 getVideoPlaybackQuality 通常为 0，没有数据就不上报。
  useEffect(() => {
    if (state.kind !== "video") return;
    const timer = window.setInterval(() => {
      const video = videoRef.current;
      if (!video) return;
      const quality = video.getVideoPlaybackQuality?.();
      const total = quality?.totalVideoFrames ?? 0;
      if (total <= 0) return;
      reportMediaQuality({
        total,
        dropped: quality?.droppedVideoFrames ?? 0,
        readyState: video.readyState,
      });
    }, QUALITY_SAMPLE_MS);
    return () => window.clearInterval(timer);
  }, [state.kind]);

  const config = state.config;
  const kind = state.kind;
  const url = state.view?.assetUrl ?? null;
  const resolvedFit = fit ?? config?.fit ?? "cover";
  const resolvedPosition = position ?? config?.position ?? "center";
  const showImage = kind === "image" && url !== null;

  return (
    <div
      className={className}
      data-testid="media-surface"
      data-backend={state.backend ?? (showImage ? "image" : "idle")}
      data-kind={kind ?? undefined}
      style={{
        position: "absolute",
        inset: 0,
        overflow: "hidden",
        backgroundColor: "#050a10",
      }}
      aria-hidden="true"
    >
      {showImage ? (
        <img
          data-testid="media-image"
          src={url}
          alt=""
          draggable={false}
          style={{
            width: "100%",
            height: "100%",
            objectFit: mediaObjectFit(resolvedFit),
            objectPosition: mediaObjectPosition(resolvedPosition),
            pointerEvents: "none",
            display: "block",
            userSelect: "none",
          }}
        />
      ) : (
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
      )}
    </div>
  );
}
