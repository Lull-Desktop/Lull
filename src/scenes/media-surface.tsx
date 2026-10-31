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
  onMediaResync,
  onMediaStreamStalled,
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
/** 原生 MediaStream 无新帧超过该时长，认为画面已黑，尝试重挂一次。 */
const NATIVE_STALL_TIMEOUT_MS = 5_000;

type FrameCallbackVideo = HTMLVideoElement & {
  requestVideoFrameCallback?: (callback: () => void) => number;
  cancelVideoFrameCallback?: (id: number) => void;
};

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
  const streamIdRef = useRef<string | null>(null);
  const trackRef = useRef<MediaStreamTrack | null>(null);
  const timeoutRef = useRef<number | null>(null);
  const disposedRef = useRef(false);
  // React StrictMode 会 setup → cleanup → setup；异步 load 必须按 runId 失效，
  // 否则第一轮会在 cleanup 之后继续 attach，造成同一窗口重复建 TextureStream。
  const runIdRef = useRef(0);
  const nativeFrameAtRef = useRef(0);
  const nativeFrameCallbackRef = useRef<number | null>(null);
  const nativeFrameWatchSupportedRef = useRef(false);
  const nativeRecoveriesRef = useRef(0);
  // Rust 的“流已死”事件与本地重挂之间的去抖，避免同一帧收到两次事件。
  const lastStallAtRef = useRef(0);
  const masterVisibleRef = useRef(true);
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

  const stopNativeFrameWatch = useCallback(() => {
    const video = videoRef.current as FrameCallbackVideo | null;
    if (
      nativeFrameCallbackRef.current !== null &&
      video?.cancelVideoFrameCallback
    ) {
      video.cancelVideoFrameCallback(nativeFrameCallbackRef.current);
    }
    nativeFrameCallbackRef.current = null;
  }, []);

  const startNativeFrameWatch = useCallback(
    (video: FrameCallbackVideo) => {
      stopNativeFrameWatch();
      if (typeof video.requestVideoFrameCallback !== "function") {
        nativeFrameWatchSupportedRef.current = false;
        return;
      }
      nativeFrameWatchSupportedRef.current = true;
      nativeFrameAtRef.current = performance.now();
      const onFrame = () => {
        nativeFrameAtRef.current = performance.now();
        nativeRecoveriesRef.current = 0;
        nativeFrameCallbackRef.current =
          video.requestVideoFrameCallback?.(onFrame) ?? null;
      };
      nativeFrameCallbackRef.current =
        video.requestVideoFrameCallback?.(onFrame) ?? null;
    },
    [stopNativeFrameWatch],
  );

  const stopNativeTrack = useCallback(() => {
    stopNativeFrameWatch();
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
  }, [stopNativeFrameWatch]);

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
    (
      url: string,
      config: MediaConfig,
      reason: string | null,
      runId?: number,
    ) => {
      if (
        disposedRef.current ||
        (runId !== undefined && runIdRef.current !== runId)
      ) {
        return;
      }
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

  const load = useCallback(
    async (runId: number) => {
      const active = (): boolean =>
        runIdRef.current === runId && !disposedRef.current;
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
      if (!active()) return;
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
      if (!active()) return;
      if (!opened) {
        switchToHtmlFallback(
          view.assetUrl,
          config,
          "原生会话不可用，已回退 HTML",
          runId,
        );
        return;
      }
      sessionRef.current = opened.sessionId;
      setState((current) => ({ ...current, sessionId: opened.sessionId }));

      const attached = await attachMediaSession(opened.sessionId);
      if (!active()) {
        // 本轮已经失效（StrictMode/重载）：按 stream id 精确解绑，不能误删
        // 新一轮已经 attach 的 Surface。
        if (attached) {
          void detachMediaSession(opened.sessionId, attached.streamId);
        }
        return;
      }
      streamIdRef.current = attached?.streamId ?? null;
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
        switchToHtmlFallback(
          url,
          config,
          attached?.reason ?? native.reason,
          runId,
        );
        return;
      }

      const video = videoRef.current;
      let stream = await getWebView2TextureStream(attached.streamId ?? "");
      if (!active()) return;
      if (!stream) {
        // 显示器重新打开/StrictMode 双挂载时，旧 Surface 可能留下一个
        // 未 StartRequested 的 TextureStream；直接 degrade 会永久回退 HTML。
        // 这里重新 attach 一次，用新 stream id 再取流，失败才降级。
        const retry = await attachMediaSession(opened.sessionId);
        if (!active()) {
          if (retry) {
            void detachMediaSession(opened.sessionId, retry.streamId);
          }
          return;
        }
        if (retry?.backend === "native-texture" && retry.streamId) {
          streamIdRef.current = retry.streamId;
          stream = await getWebView2TextureStream(retry.streamId);
        }
      }
      if (!active()) return;
      if (!video || !stream) {
        await degradeMediaSession(
          opened.sessionId,
          "WebView2 TextureStream 首帧失败",
        );
        switchToHtmlFallback(url, config, "原生纹理不可用，已回退 HTML", runId);
        return;
      }
      applyVideoConfig(video, config);
      trackRef.current = stream.getVideoTracks()[0] ?? null;
      video.srcObject = stream;
      startNativeFrameWatch(video as FrameCallbackVideo);
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
            switchToHtmlFallback(
              url,
              config,
              "自动播放失败，已回退 HTML",
              runId,
            );
          },
        );
      });
      clearNativeTimer();
      timeoutRef.current = window.setTimeout(() => {
        void degradeMediaSession(
          opened.sessionId,
          "12 秒内未收到原生首帧",
        ).then(() => {
          switchToHtmlFallback(url, config, "原生首帧超时，已回退 HTML", runId);
        });
      }, NATIVE_FIRST_FRAME_TIMEOUT_MS);
    },
    [
      clearNativeTimer,
      onBackendChange,
      startNativeFrameWatch,
      switchToHtmlFallback,
    ],
  );

  // biome-ignore lint/correctness/useExhaustiveDependencies: reloadKey intentionally restarts cleanup + load
  useEffect(() => {
    const runId = ++runIdRef.current;
    disposedRef.current = false;
    void load(runId);
    return () => {
      // 让仍在 await 的 load 失效，避免 StrictMode 的第一轮在 cleanup 后
      // 继续 open/attach（那会在同一窗口重复创建 TextureStream）。
      if (runIdRef.current === runId) runIdRef.current += 1;
      disposedRef.current = true;
      clearNativeTimer();
      stopNativeTrack();
      const sessionId = sessionRef.current;
      const streamId = streamIdRef.current;
      sessionRef.current = null;
      streamIdRef.current = null;
      if (sessionId && streamId) {
        void detachMediaSession(sessionId, streamId);
      }
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

  // 原生流有首帧不代表之后一直在出帧：显示器全关再开、WebView2 合成器
  // 重新唤醒时可能停在黑帧。用 requestVideoFrameCallback 看“最近一次真正
  // 呈现的帧”；超过 5 秒没有新帧就重挂一次，连续失败才回退 HTML。
  useEffect(() => {
    if (
      state.backend !== "native-texture" ||
      !nativeFrameWatchSupportedRef.current
    ) {
      return;
    }
    const timer = window.setInterval(() => {
      if (disposedRef.current || document.hidden) return;
      const video = videoRef.current;
      if (!video || video.paused) return;
      if (
        performance.now() - nativeFrameAtRef.current <
        NATIVE_STALL_TIMEOUT_MS
      ) {
        return;
      }
      if (nativeRecoveriesRef.current >= 2) {
        const sessionId = sessionRef.current;
        const assetUrl = state.view?.assetUrl;
        if (!sessionId || !state.config || !assetUrl) return;
        void degradeMediaSession(sessionId, "原生纹理持续无帧").then(() => {
          if (disposedRef.current || !state.config) return;
          switchToHtmlFallback(
            assetUrl,
            state.config,
            "原生纹理持续无帧，已回退 HTML",
          );
        });
        return;
      }
      nativeRecoveriesRef.current += 1;
      nativeFrameAtRef.current = performance.now();
      setReloadKey((key) => key + 1);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [state.backend, state.view?.assetUrl, state.config, switchToHtmlFallback]);

  // 原生流本身已经不可能再出帧（浏览器 Stopped、渲染侧 Error、适配器丢失，
  // 或渲染侧长时间不归还目标纹理）。Rust 在丢帧路径上直接发事件，这里立刻重挂，
  // 不再等上面 5 秒一轮的 rVFC 看门狗——那 5 秒正是“黑屏慢慢恢复”的来源。
  // 连续两次都救不回来才降级 HTML，与看门狗共用同一个恢复计数。
  useEffect(() => {
    return onMediaStreamStalled((event) => {
      if (disposedRef.current) return;
      if (!streamIdRef.current || event.streamId !== streamIdRef.current)
        return;
      const video = videoRef.current;
      // 已经切 HTML / 正在卸载时 srcObject 已清空：这条通知是旧流的尾声，
      // 再重挂会把刚降级好的页面又拉回原生。
      if (!video || video.paused || !video.srcObject) return;
      const now = performance.now();
      if (now - lastStallAtRef.current < 2_000) return;
      lastStallAtRef.current = now;
      const sessionId = sessionRef.current;
      const config = configRef.current;
      const assetUrl = state.view?.assetUrl;
      if (!sessionId || !config || !assetUrl) return;
      nativeFrameAtRef.current = now;
      if (nativeRecoveriesRef.current >= 2) {
        void degradeMediaSession(
          sessionId,
          `原生纹理流已停止（${event.reason}）`,
        ).then(() => {
          const current = configRef.current;
          if (disposedRef.current || !current) return;
          switchToHtmlFallback(
            assetUrl,
            current,
            `原生纹理流已停止（${event.reason}），已回退 HTML`,
          );
        });
        return;
      }
      nativeRecoveriesRef.current += 1;
      setReloadKey((key) => key + 1);
    });
  }, [state.view?.assetUrl, switchToHtmlFallback]);

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
      masterVisibleRef.current = visible;
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

  // 设置页「重新同步播放」：原生会话已在 Rust seek；HTML 这里按同一点 seek
  // 并恢复播放。positionMs 为 0 时就是所有显示器从素材开头重新开始。
  useEffect(() => {
    return onMediaResync((positionMs) => {
      const video = videoRef.current;
      if (!video) return;
      nativeFrameAtRef.current = performance.now();
      const isHtml = !video.srcObject && Boolean(video.getAttribute("src"));
      if (isHtml) {
        const seconds = Math.max(0, positionMs / 1000);
        try {
          const duration = video.duration;
          video.currentTime =
            Number.isFinite(duration) && duration > 0
              ? seconds % duration
              : seconds;
        } catch {
          // metadata 尚未就绪；下一次可见/播放入口会重新对齐。
        }
      }
      if (
        masterVisibleRef.current &&
        (video.srcObject || video.getAttribute("src"))
      ) {
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
