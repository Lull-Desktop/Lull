/**
 * LiquidPlayer（液态黑胶播放器）：把本地音频播放入口重构成参考稿里的水晶玻璃浮窗。
 *
 * 主球负责封面、播放 / 暂停、频响涟漪与进度环拖拽；左侧三颗循环泡切换播放模式，
 * 右侧水幕抽屉承载本地 / 在线双曲库。在线精选不依赖网络，由 AmbientStream 现场合成，
 * 因此断网时列表依旧可以播放并驱动主球频响。
 */
"use client";

import {
  AudioLines,
  ChevronLeft,
  ChevronRight,
  ChevronsLeftRight,
  Cloud,
  FolderOpen,
  HardDrive,
  LoaderCircle,
  Minus,
  Pause,
  Play,
  Plus,
  Repeat1,
  Repeat2,
  Shuffle,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  ChangeEvent,
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isWidgetAudioAvailable,
  isWidgetMediaAvailable,
  onWidgetPrefsChanged,
  widgetAlignPlayer,
  widgetHideWindow,
  widgetIsMinimizable,
  widgetMinimizeWindow,
  widgetResizeWidth,
} from "@/sdk/widget";
import { useWidgetFit, useWidgetTheme } from "@/sdk/widget/react";
import { AmbientStream } from "./ambient-stream";
import { CoverArt } from "./cover-art";
import styles from "./liquid-player.module.css";
import {
  clampVolume,
  coverPalette,
  coverToneForText,
  findTrackById,
  formatClock,
  formatTrackDuration,
  nextIndexForMode,
  ONLINE_TRACKS,
  PLAY_MODE_OPTIONS,
  type PlayerSource,
  type PlayerTrack,
  type PlayMode,
  parseTrackName,
  persistPlayerPrefs,
  playModeLabel,
  previousIndex,
  readPlayerPrefs,
  totalDuration,
} from "./player-model";

const DEFAULT_TRACK = ONLINE_TRACKS[0] ?? null;
const DEFAULT_TRACK_ID = DEFAULT_TRACK?.id ?? "";
const SEEK_STEP_SECONDS = 5;
/** 展开曲库的完整画布；收起时收到 530，左右留白正好包住主球与曲库泡。 */
/** 右停靠展开的完整画布；收起时收到 530。左停靠始终保留 880。 */
const PLAYER_OPEN_WIDTH = 880;
const PLAYER_COMPACT_WIDTH = 530;
/** 抽屉的淡出 / 淡入时长；右停靠收起后等淡出完成再收窗口。 */
const DRAWER_FADE_MS = 240;
const DRAWER_CLOSE_MS = DRAWER_FADE_MS + 20;
/** 左右换边时先让抽屉淡出，换完布局与窗口位置后重新淡入。 */
const DOCK_SWITCH_FADE_MS = DRAWER_FADE_MS;
/** 与白噪音一致的雾化重组时长：整组播放器 blur + 位移 + 淡入。 */
const DOCK_SWITCH_ANIM_MS = 820;
/** 换边前先把旧播放器淡出，让原生窗口在不可见状态下完成移动。 */
const DOCK_PLAYER_EXIT_MS = 200;
/** 主球球心到窗口同侧边缘的 CSS 像素。 */
const PLAYER_DOCK_ANCHOR = 287;
/** 三个模式泡沿主球左侧 / 右侧边缘的弧度。角度以 CSS 坐标（y 向下）计。 */
const MODE_ARC_ANGLES = [224, 206, 188] as const;
const MODE_ARC_RADIUS = 184;
const MODE_BUBBLE_HALF = 22;
const ORB_CENTER_IN_STAGE = 148;
type DockSide = "left" | "right";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    window.setTimeout(resolve, ms);
  });
}

/** 等两帧，让原生窗口的新位置先提交到合成器，再翻转 DOM 布局。 */
function waitForNextFrames(): Promise<void> {
  return new Promise((resolve) => {
    window.requestAnimationFrame(() => {
      window.requestAnimationFrame(() => resolve());
    });
  });
}

/**
 * 等某个节点真正退场（透明度过渡结束）再继续换边。
 * 只靠固定 sleep 会和浏览器的首帧调度赛跑，慢一帧就会把还没淡完的
 * 内容带到窗口移动的那一帧；这里以 transitionend 为准，并用一个比
 * CSS 过渡略长的超时兜底（reduced-motion / 无过渡时也能继续）。
 */
function waitForOpacityExit(
  node: HTMLElement | null,
  fallbackMs: number,
): Promise<void> {
  if (!node) return Promise.resolve();
  return new Promise((resolve) => {
    let settled = false;
    const finish = (): void => {
      if (settled) return;
      settled = true;
      node.removeEventListener("transitionend", onEnd);
      window.clearTimeout(timer);
      resolve();
    };
    const onEnd = (event: TransitionEvent): void => {
      if (event.target === node && event.propertyName === "opacity") finish();
    };
    node.addEventListener("transitionend", onEnd);
    const timer = window.setTimeout(finish, fallbackMs);
  });
}
const MODE_GLYPHS = {
  sequence: Repeat2,
  shuffle: Shuffle,
  "repeat-one": Repeat1,
} as const;
const AUDIO_EXTENSION = /\.(mp3|wav|flac|ogg|oga|m4a|aac|opus|webm|aiff?)$/i;
const DISSOLVE_ANGLES = [
  0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330,
] as const;

let localTrackSequence = 0;

function nextLocalTrackId(): string {
  localTrackSequence += 1;
  return `local-${Date.now().toString(36)}-${localTrackSequence}`;
}

function isAudioFile(file: File): boolean {
  return file.type.startsWith("audio/") || AUDIO_EXTENSION.test(file.name);
}

function resolveAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

function analyserLevel(
  analyser: AnalyserNode,
  data: Uint8Array<ArrayBuffer>,
): number {
  analyser.getByteFrequencyData(data);
  const limit = Math.min(data.length, 48);
  let sum = 0;
  for (let index = 1; index < limit; index += 1) {
    sum += data[index] ?? 0;
  }
  const average = sum / Math.max(1, (limit - 1) * 255);
  return Math.min(1, average * 2.3);
}

/**
 * 主球进度环的几何：0 在正上方，顺时针增长。
 * SVG 里用 pathLength=100 后可以直接拿百分比驱动 dasharray。
 */
function ratioFromPointer(
  element: SVGSVGElement,
  clientX: number,
  clientY: number,
): number {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return 0;
  const centerX = rect.left + rect.width / 2;
  const centerY = rect.top + rect.height / 2;
  const angle = Math.atan2(clientY - centerY, clientX - centerX);
  const normalized = (angle + Math.PI / 2) / (Math.PI * 2);
  return (normalized + 1) % 1;
}

export function LiquidPlayer(): React.ReactElement {
  const [tracks, setTracks] = useState<PlayerTrack[]>([]);
  const [tab, setTab] = useState<PlayerSource>("online");
  const [currentId, setCurrentId] = useState(DEFAULT_TRACK_ID);
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<PlayMode>("sequence");
  const [volume, setVolume] = useState(78);
  const [lastAudibleVolume, setLastAudibleVolume] = useState(78);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerHeld, setDrawerHeld] = useState(false);
  const [dockSide, setDockSide] = useState<DockSide>("right");
  const [dockLeaving, setDockLeaving] = useState(false);
  const [dockSwitching, setDockSwitching] = useState(false);
  const [dockVeil, setDockVeil] = useState(false);
  const [dockBusy, setDockBusy] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [canMinimize, setCanMinimize] = useState(false);
  const [themeReady, setThemeReady] = useState(false);

  const { themeId } = useWidgetTheme();
  const panelId = useId().replace(/[^a-zA-Z0-9_-]/g, "") || "tracklist";

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerClusterRef = useRef<HTMLElement>(null);
  const drawerSlotRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const audioRef = useRef<HTMLAudioElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const localTabRef = useRef<HTMLButtonElement>(null);
  const onlineTabRef = useRef<HTMLButtonElement>(null);

  const tracksRef = useRef<PlayerTrack[]>([]);
  const currentRef = useRef<PlayerTrack | null>(DEFAULT_TRACK);
  const currentIdRef = useRef(DEFAULT_TRACK_ID);
  const loadedIdRef = useRef(DEFAULT_TRACK_ID);
  const playingRef = useRef(false);
  const progressRef = useRef(0);
  const modeRef = useRef<PlayMode>("sequence");
  const volumeRef = useRef(78);
  const requestAutoplayRef = useRef(false);
  const scrubPointerRef = useRef<number | null>(null);
  const scrubRef = useRef(false);
  const volumeTrackRef = useRef<HTMLDivElement>(null);
  const volumePointerRef = useRef<number | null>(null);
  const endedGuardRef = useRef(false);
  const objectUrlsRef = useRef<string[]>([]);
  const ambientRef = useRef<AmbientStream | null>(null);
  const onlineClockRef = useRef({ startedAt: 0, offset: 0 });
  const uiContextRef = useRef<AudioContext | null>(null);
  const localAnalyserRef = useRef<{
    context: AudioContext;
    analyser: AnalyserNode;
    data: Uint8Array<ArrayBuffer>;
  } | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const drawerWidthTimerRef = useRef<number | null>(null);
  const drawerOpenRef = useRef(true);
  const dockSideRef = useRef<DockSide>("right");
  const dockSwitchBusyRef = useRef(false);
  const dragDepthRef = useRef(0);
  const handleEndedRef = useRef<() => void>(() => {});
  const commitSeekRef = useRef<(value: number) => void>(() => {});

  // 播放器是固定画布的透明浮窗：只需要等字体就绪后显示窗口，
  // 不能再按内容高度贴合（100vh 内容叠加顶栏高度会让窗口反复长高）。
  useWidgetFit(rootRef, { fit: false });

  const allTracks = useMemo(() => [...ONLINE_TRACKS, ...tracks], [tracks]);
  const current = findTrackById(allTracks, currentId) ?? DEFAULT_TRACK ?? null;
  const currentTone = current?.tone ?? 0;
  const palette = coverPalette(currentTone);
  const duration = current?.duration ?? 0;
  const visibleTracks = tab === "online" ? ONLINE_TRACKS : tracks;
  const currentList = current?.source === "online" ? ONLINE_TRACKS : tracks;
  const displayProgress = scrubbing ? scrubValue : progress;
  const progressRatio =
    duration > 0 ? Math.min(1, Math.max(0, displayProgress / duration)) : 0;
  const progressPercent = progressRatio * 100;
  const knobAngle = progressRatio * 360;
  const scrubAngle = progressRatio * Math.PI * 2 - Math.PI / 2;
  const scrubBubbleX = 50 + Math.cos(scrubAngle) * 46;
  const scrubBubbleY = 50 + Math.sin(scrubAngle) * 46;
  const listLength = currentList.length;
  const canSkip = current !== null && listLength > 1;

  const rootStyle = {
    "--accent": palette.accent,
    "--accent-soft": palette.accentSoft,
    "--cover-glow": palette.sunGlow,
    "--cover-water": palette.waterLight,
    "--cover-far": palette.far,
  } as CSSProperties;

  useEffect(() => {
    currentRef.current = current;
    currentIdRef.current = current?.id ?? currentId;
  }, [current, currentId]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    tracksRef.current = tracks;
  }, [tracks]);

  useEffect(() => {
    modeRef.current = mode;
  }, [mode]);

  useEffect(() => {
    volumeRef.current = volume;
    if (volume > 0) setLastAudibleVolume(volume);
    const audio = audioRef.current;
    if (audio) audio.volume = volume / 100;
    ambientRef.current?.setVolume(volume);
  }, [volume]);

  // WebView 页面透明：窗口本身在 Rust 侧以 transparent 创建，桌面从玻璃件之间透出来。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lull-transparent-window");
    return () => root.classList.remove("lull-transparent-window");
  }, []);

  // 读取上次的播放模式与音量；只读一次，避免后续写入与读取互相覆盖。
  useEffect(() => {
    const stored = readPlayerPrefs();
    if (stored.mode) setMode(stored.mode);
    if (stored.volume !== undefined) {
      setVolume(stored.volume);
      if (stored.volume > 0) setLastAudibleVolume(stored.volume);
    }
    setThemeReady(true);
  }, []);

  useEffect(() => {
    if (!themeReady) return;
    persistPlayerPrefs({ mode, volume });
  }, [mode, volume, themeReady]);

  useEffect(() => {
    let alive = true;
    const sync = (): void => {
      void widgetIsMinimizable().then((value) => {
        if (alive) setCanMinimize(value);
      });
    };
    sync();
    const stop = onWidgetPrefsChanged(sync);
    return () => {
      alive = false;
      stop();
    };
  }, []);

  // WebView 重载后组件默认展开；右停靠收起时把窗口放回 880 展开画布。
  useEffect(() => {
    const width =
      dockSideRef.current === "left" || drawerOpenRef.current
        ? PLAYER_OPEN_WIDTH
        : PLAYER_COMPACT_WIDTH;
    void widgetResizeWidth(
      width,
      dockSideRef.current === "left" ? "right" : "left",
    );
  }, []);

  const showNotice = useCallback((message: string): void => {
    setNotice(message);
    if (noticeTimerRef.current !== null) {
      window.clearTimeout(noticeTimerRef.current);
    }
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice(null);
      noticeTimerRef.current = null;
    }, 2200);
  }, []);

  /**
   * 曲库开关：
   * - 右停靠：展开放宽到 880，收起等淡出后再收到 530；
   * - 左停靠：窗口始终保持 880，只做抽屉透明度，绝不再改原生窗口尺寸 / 位置。
   * 这是左停靠不再抖动的关键。
   */
  const setDrawer = useCallback((open: boolean): void => {
    drawerOpenRef.current = open;
    setDrawerOpen(open);
    if (drawerWidthTimerRef.current !== null) {
      window.clearTimeout(drawerWidthTimerRef.current);
      drawerWidthTimerRef.current = null;
    }
    if (open) {
      if (dockSideRef.current === "right") {
        void widgetResizeWidth(PLAYER_OPEN_WIDTH, "left");
      }
      return;
    }
    if (dockSideRef.current === "left") return;
    drawerWidthTimerRef.current = window.setTimeout(() => {
      drawerWidthTimerRef.current = null;
      if (!drawerOpenRef.current) {
        void widgetResizeWidth(PLAYER_COMPACT_WIDTH, "left");
      }
    }, DRAWER_CLOSE_MS);
  }, []);

  /**
   * 曲库左右停靠切换。
   * 对齐白噪音的换边仪式，同时避开原生窗口移动与 DOM 镜像的时序差：
   * 1. 旧播放器淡出、抽屉雾化退场，换边光雾同时升起；
   * 2. 画面完全隐藏后先移动原生窗口，让 306px 的窗口位移发生在「空场」里；
   * 3. 窗口就位后翻转子布局并触发 materialize，新播放器第一帧就在正确坐标；
   * 4. 抽屉从新的一侧雾化淡入，光雾随后退去。
   * 左停靠目标宽度固定 880，右停靠关闭态才使用 530。
   */
  const changeDockSide = useCallback((next: DockSide): void => {
    if (next === dockSideRef.current || dockSwitchBusyRef.current) return;
    if (drawerWidthTimerRef.current !== null) {
      window.clearTimeout(drawerWidthTimerRef.current);
      drawerWidthTimerRef.current = null;
    }
    const currentSide = dockSideRef.current;
    const wasOpen = drawerOpenRef.current;
    const targetWidth =
      next === "left"
        ? PLAYER_OPEN_WIDTH
        : wasOpen
          ? PLAYER_OPEN_WIDTH
          : PLAYER_COMPACT_WIDTH;
    const run = async (): Promise<void> => {
      dockSwitchBusyRef.current = true;
      setDockBusy(true);
      // 先挂好两个退场监听，再切状态；确保窗口移动前两者都真的不可见。
      const playerExit = waitForOpacityExit(
        playerClusterRef.current,
        DOCK_PLAYER_EXIT_MS + 140,
      );
      const drawerExit = wasOpen
        ? waitForOpacityExit(drawerSlotRef.current, DOCK_SWITCH_FADE_MS + 180)
        : Promise.resolve();
      setDockLeaving(true);
      setDockVeil(true);
      if (wasOpen) setDrawerHeld(true);
      // 旧播放器淡出与抽屉退场并行；两者都结束后，画面里不再有会跳动的内容。
      await Promise.all([playerExit, drawerExit]);

      // 此时播放器 opacity 已为 0、抽屉不可见；先在「空场」里原子移动原生窗口。
      await widgetAlignPlayer(
        currentSide,
        next,
        targetWidth,
        PLAYER_DOCK_ANCHOR,
      );
      // 等窗口新位置真正提交后再翻布局，新内容的第一帧就落在新坐标上。
      await waitForNextFrames();

      const startedAt = performance.now();
      dockSideRef.current = next;
      setDockLeaving(false);
      setDockSide(next);
      setDockSwitching(true);
      if (wasOpen) setDrawerHeld(false);
      setDockBusy(false);
      // 动画在 setDockSwitching(true) 那一帧就开始了，只补足剩余时间。
      const remaining = DOCK_SWITCH_ANIM_MS - (performance.now() - startedAt);
      if (remaining > 0) await sleep(remaining);
      setDockSwitching(false);
      setDockVeil(false);
      dockSwitchBusyRef.current = false;
    };
    void run();
  }, []);

  const updateTrackDuration = useCallback(
    (trackId: string, value: number): void => {
      if (!Number.isFinite(value) || value <= 0) return;
      setTracks((previous) =>
        previous.map((track) =>
          track.id === trackId && Math.abs(track.duration - value) > 0.25
            ? { ...track, duration: value }
            : track,
        ),
      );
    },
    [],
  );

  const ensureUiContext = useCallback((): AudioContext | null => {
    if (!isWidgetAudioAvailable()) return null;
    if (uiContextRef.current) {
      if (uiContextRef.current.state === "suspended") {
        void uiContextRef.current.resume().catch(() => {});
      }
      return uiContextRef.current;
    }
    const Ctor = resolveAudioContextCtor();
    if (!Ctor) return null;
    try {
      uiContextRef.current = new Ctor();
      return uiContextRef.current;
    } catch (error) {
      console.error("[player] 无法创建音频上下文", error);
      return null;
    }
  }, []);

  // 本地音频接一次 MediaElementSource，让主球频响跟随真实播放内容。
  const ensureLocalAnalyser = useCallback((): {
    context: AudioContext;
    analyser: AnalyserNode;
    data: Uint8Array<ArrayBuffer>;
  } | null => {
    if (localAnalyserRef.current) return localAnalyserRef.current;
    const audio = audioRef.current;
    const context = ensureUiContext();
    if (!audio || !context) return null;
    try {
      const source = context.createMediaElementSource(audio);
      const analyser = context.createAnalyser();
      analyser.fftSize = 128;
      analyser.smoothingTimeConstant = 0.82;
      source.connect(analyser);
      analyser.connect(context.destination);
      const data = new Uint8Array(analyser.frequencyBinCount);
      localAnalyserRef.current = { context, analyser, data };
      return localAnalyserRef.current;
    } catch (error) {
      console.error("[player] 无法连接频响分析器", error);
      return null;
    }
  }, [ensureUiContext]);

  /** 切歌时一声很轻的水滴「啵」，与 0.35s 封面晕染同步。 */
  const playDropSound = useCallback((): void => {
    if (volumeRef.current <= 0) return;
    const context = ensureUiContext();
    if (!context) return;
    try {
      const now = context.currentTime;
      const oscillator = context.createOscillator();
      const gain = context.createGain();
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(540, now);
      oscillator.frequency.exponentialRampToValueAtTime(148, now + 0.16);
      gain.gain.setValueAtTime(0.0001, now);
      gain.gain.exponentialRampToValueAtTime(
        0.045 * (volumeRef.current / 100),
        now + 0.012,
      );
      gain.gain.exponentialRampToValueAtTime(0.0001, now + 0.24);
      oscillator.connect(gain);
      gain.connect(context.destination);
      oscillator.start(now);
      oscillator.stop(now + 0.26);
    } catch (error) {
      console.error("[player] 水滴音效失败", error);
    }
  }, [ensureUiContext]);

  const startAmbient = useCallback(
    (track: PlayerTrack, offset: number): boolean => {
      if (track.source !== "online" || !track.ambient) return false;
      if (!isWidgetAudioAvailable()) return false;
      try {
        ambientRef.current ??= new AmbientStream();
        ambientRef.current.setVolume(volumeRef.current);
        ambientRef.current.start(track.ambient, offset);
        return true;
      } catch (error) {
        console.error("[player] 在线氛围合成失败", error);
        showNotice("音频引擎启动失败，请重试");
        return false;
      }
    },
    [showNotice],
  );

  const pausePlayback = useCallback((): void => {
    const track = currentRef.current;
    const audio = audioRef.current;
    if (track?.source === "local") {
      audio?.pause();
      if (audio && Number.isFinite(audio.currentTime)) {
        setProgress(audio.currentTime);
        progressRef.current = audio.currentTime;
      }
    } else if (track?.source === "online") {
      const elapsed = Math.min(
        track.duration,
        onlineClockRef.current.offset +
          (performance.now() - onlineClockRef.current.startedAt) / 1000,
      );
      onlineClockRef.current.offset = elapsed;
      setProgress(elapsed);
      progressRef.current = elapsed;
      ambientRef.current?.stop();
    }
    endedGuardRef.current = false;
    setPlaying(false);
    playingRef.current = false;
    setPulseKey((value) => value + 1);
  }, []);

  const startPlayback = useCallback((): void => {
    const track = currentRef.current;
    if (!track) {
      setDrawer(true);
      showNotice("先从曲库选择一首音频");
      return;
    }
    endedGuardRef.current = false;
    if (track.source === "local") {
      const audio = audioRef.current;
      if (!audio || !track.url) {
        showNotice("这首本地音频已经失效，请重新导入");
        return;
      }
      ensureLocalAnalyser();
      audio.volume = volumeRef.current / 100;
      if (
        audio.ended ||
        progressRef.current >= Math.max(0, track.duration - 0.25)
      ) {
        try {
          audio.currentTime = 0;
        } catch {
          // 元数据还没回来时设置 currentTime 会抛错，等 play 后自然从头开始。
        }
        setProgress(0);
        progressRef.current = 0;
      }
      void audio
        .play()
        .then(() => {
          if (currentRef.current?.id !== track.id) return;
          setPlaying(true);
          playingRef.current = true;
        })
        .catch((error: unknown) => {
          if (currentRef.current?.id !== track.id) return;
          console.error("[player] 本地音频播放失败", error);
          setPlaying(false);
          playingRef.current = false;
          showNotice("音频播放失败，请重新选择文件");
        });
    } else {
      const offset =
        progressRef.current >= Math.max(0, track.duration - 0.25)
          ? 0
          : progressRef.current;
      if (!startAmbient(track, offset)) return;
      onlineClockRef.current = {
        offset,
        startedAt: performance.now(),
      };
      setProgress(offset);
      progressRef.current = offset;
      setPlaying(true);
      playingRef.current = true;
    }
    setPulseKey((value) => value + 1);
  }, [ensureLocalAnalyser, setDrawer, showNotice, startAmbient]);

  const togglePlayback = useCallback((): void => {
    if (playingRef.current) pausePlayback();
    else startPlayback();
  }, [pausePlayback, startPlayback]);

  const selectTrack = useCallback(
    (track: PlayerTrack, autoplay = playingRef.current): void => {
      if (track.id === currentIdRef.current) {
        if (!playingRef.current && autoplay) startPlayback();
        return;
      }
      const wasPlaying = playingRef.current;
      requestAutoplayRef.current = autoplay;
      currentRef.current = track;
      currentIdRef.current = track.id;
      setCurrentId(track.id);
      setTab(track.source);
      setProgress(0);
      progressRef.current = 0;
      endedGuardRef.current = false;
      setPulseKey((value) => value + 1);
      if (wasPlaying) playDropSound();
    },
    [playDropSound, startPlayback],
  );

  const moveTrack = useCallback(
    (direction: 1 | -1): void => {
      const track = currentRef.current;
      if (!track) return;
      const list =
        track.source === "online" ? ONLINE_TRACKS : tracksRef.current;
      if (list.length === 0) return;
      const index = Math.max(
        0,
        list.findIndex((item) => item.id === track.id),
      );
      const target =
        direction > 0
          ? (list[nextIndexForMode(index, list.length, "sequence")] ?? null)
          : (list[previousIndex(index, list.length)] ?? null);
      if (target) selectTrack(target, playingRef.current);
    },
    [selectTrack],
  );

  const handleEnded = useCallback((): void => {
    const track = currentRef.current;
    if (!track) return;
    setPlaying(false);
    playingRef.current = false;
    if (modeRef.current === "repeat-one") {
      setProgress(0);
      progressRef.current = 0;
      endedGuardRef.current = false;
      if (track.source === "local") {
        const audio = audioRef.current;
        if (audio) {
          try {
            audio.currentTime = 0;
          } catch {
            // 元数据异常时直接让 play() 处理。
          }
        }
      }
      startPlayback();
      return;
    }
    const list = track.source === "online" ? ONLINE_TRACKS : tracksRef.current;
    if (list.length === 0) return;
    const index = Math.max(
      0,
      list.findIndex((item) => item.id === track.id),
    );
    const next = list[nextIndexForMode(index, list.length, modeRef.current)];
    if (next) selectTrack(next, true);
  }, [selectTrack, startPlayback]);

  useEffect(() => {
    handleEndedRef.current = handleEnded;
  }, [handleEnded]);

  const commitSeek = useCallback(
    (value: number): void => {
      const track = currentRef.current;
      if (!track) return;
      const maximum = track.duration > 0 ? track.duration : value;
      const clamped = Math.min(maximum, Math.max(0, value));
      setProgress(clamped);
      progressRef.current = clamped;
      if (track.source === "local") {
        const audio = audioRef.current;
        if (audio && Number.isFinite(audio.duration) && audio.duration > 0) {
          try {
            audio.currentTime = Math.min(audio.duration, clamped);
          } catch {
            // 元数据还没回来时忽略这次 seek。
          }
        }
      } else {
        onlineClockRef.current = {
          offset: clamped,
          startedAt: performance.now(),
        };
        if (playingRef.current) startAmbient(track, clamped);
      }
    },
    [startAmbient],
  );

  useEffect(() => {
    commitSeekRef.current = commitSeek;
  }, [commitSeek]);

  const seekRelative = useCallback((delta: number): void => {
    commitSeekRef.current(progressRef.current + delta);
  }, []);

  const ringPointerDown = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (event.button !== 0 || !current || duration <= 0) return;
    event.preventDefault();
    const ratio = ratioFromPointer(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    const value = ratio * duration;
    scrubPointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    scrubRef.current = true;
    setScrubbing(true);
    setScrubValue(value);
    setProgress(value);
    progressRef.current = value;
  };

  const ringPointerMove = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (scrubPointerRef.current !== event.pointerId || !current) return;
    const ratio = ratioFromPointer(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    const value = ratio * duration;
    setScrubValue(value);
    setProgress(value);
    progressRef.current = value;
  };

  const endRingPointer = (event: ReactPointerEvent<SVGSVGElement>): void => {
    if (scrubPointerRef.current !== event.pointerId) return;
    scrubPointerRef.current = null;
    scrubRef.current = false;
    setScrubbing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitSeekRef.current(progressRef.current);
  };

  const ringKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (!current || duration <= 0) return;
    let next: number | null = null;
    if (event.key === "ArrowRight" || event.key === "ArrowUp") {
      next = progressRef.current + SEEK_STEP_SECONDS;
    } else if (event.key === "ArrowLeft" || event.key === "ArrowDown") {
      next = progressRef.current - SEEK_STEP_SECONDS;
    } else if (event.key === "PageUp") {
      next = progressRef.current + 30;
    } else if (event.key === "PageDown") {
      next = progressRef.current - 30;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = duration;
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    commitSeekRef.current(next);
  };

  const chooseMode = useCallback(
    (nextMode: PlayMode): void => {
      setMode(nextMode);
      showNotice(playModeLabel(nextMode));
    },
    [showNotice],
  );

  const switchTab = useCallback((next: PlayerSource): void => {
    setTab(next);
    listRef.current?.scrollTo?.({ top: 0, behavior: "smooth" });
  }, []);

  const probeTrackDuration = useCallback(
    (track: PlayerTrack): void => {
      if (!track.url || typeof Audio === "undefined") return;
      const probe = new Audio();
      probe.preload = "metadata";
      const finish = (): void => {
        if (Number.isFinite(probe.duration) && probe.duration > 0) {
          updateTrackDuration(track.id, probe.duration);
        }
        probe.removeAttribute("src");
        probe.load();
      };
      probe.addEventListener("loadedmetadata", finish, { once: true });
      probe.addEventListener(
        "error",
        () => {
          probe.removeAttribute("src");
          probe.load();
        },
        { once: true },
      );
      probe.src = track.url;
      probe.load();
    },
    [updateTrackDuration],
  );

  const addFiles = useCallback(
    (files: FileList | File[] | null): void => {
      if (!files) return;
      if (!isWidgetMediaAvailable()) return;
      const incoming = Array.from(files).filter(isAudioFile);
      if (incoming.length === 0) {
        showNotice("这些文件不是可播放的音频");
        return;
      }
      const added = incoming.map((file) => {
        const url = URL.createObjectURL(file);
        objectUrlsRef.current.push(url);
        const parsed = parseTrackName(file.name);
        const track: PlayerTrack = {
          id: nextLocalTrackId(),
          title: parsed.title,
          artist: parsed.artist,
          duration: 0,
          source: "local",
          tone: coverToneForText(`${parsed.artist}-${parsed.title}`),
          url,
        };
        probeTrackDuration(track);
        return track;
      });
      setTracks((previous) => [...previous, ...added]);
      setTab("local");
      setDrawer(true);
      if (!playingRef.current) {
        const first = added[0];
        if (first) selectTrack(first, false);
      }
      showNotice(
        added.length === 1
          ? `已加入「${added[0]?.title ?? "音频"}」`
          : `已加入 ${added.length} 首本地音频`,
      );
    },
    [probeTrackDuration, selectTrack, setDrawer, showNotice],
  );

  const openFilePicker = useCallback((): void => {
    inputRef.current?.click();
  }, []);

  const toggleMute = useCallback((): void => {
    setVolume((currentVolume) =>
      currentVolume > 0 ? 0 : Math.max(1, lastAudibleVolume),
    );
  }, [lastAudibleVolume]);

  const volumeFromPointer = useCallback((clientX: number): number => {
    const rect = volumeTrackRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return volumeRef.current;
    return clampVolume(((clientX - rect.left) / rect.width) * 100);
  }, []);

  const volumePointerDown = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (event.button !== 0) return;
    event.preventDefault();
    volumePointerRef.current = event.pointerId;
    event.currentTarget.setPointerCapture(event.pointerId);
    setVolume(volumeFromPointer(event.clientX));
  };

  const volumePointerMove = (
    event: ReactPointerEvent<HTMLDivElement>,
  ): void => {
    if (volumePointerRef.current !== event.pointerId) return;
    setVolume(volumeFromPointer(event.clientX));
  };

  const volumePointerEnd = (event: ReactPointerEvent<HTMLDivElement>): void => {
    if (volumePointerRef.current !== event.pointerId) return;
    volumePointerRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const volumeKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    let next: number | null = null;
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      next = volume + 5;
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      next = volume - 5;
    } else if (event.key === "PageUp") {
      next = volume + 10;
    } else if (event.key === "PageDown") {
      next = volume - 10;
    } else if (event.key === "Home") {
      next = 0;
    } else if (event.key === "End") {
      next = 100;
    }
    if (next === null) return;
    event.preventDefault();
    event.stopPropagation();
    setVolume(clampVolume(next));
  };

  const toggleDrawer = useCallback((): void => {
    setDrawer(!drawerOpenRef.current);
  }, [setDrawer]);

  const onFileInputChange = (event: ChangeEvent<HTMLInputElement>): void => {
    addFiles(event.currentTarget.files);
    event.currentTarget.value = "";
  };

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const next: PlayerSource =
      event.key === "ArrowRight"
        ? tab === "local"
          ? "online"
          : "local"
        : tab === "online"
          ? "local"
          : "online";
    switchTab(next);
    window.setTimeout(() => {
      (next === "local" ? localTabRef : onlineTabRef).current?.focus();
    }, 0);
  };

  const onDragEnter = (event: DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current += 1;
    setDropActive(true);
  };

  const onDragOver = (event: DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    event.dataTransfer.dropEffect = "copy";
  };

  const onDragLeave = (event: DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
    if (dragDepthRef.current === 0) setDropActive(false);
  };

  const onDrop = (event: DragEvent<HTMLElement>): void => {
    if (!event.dataTransfer.types.includes("Files")) return;
    event.preventDefault();
    dragDepthRef.current = 0;
    setDropActive(false);
    addFiles(event.dataTransfer.files);
  };

  // 换曲 / 换源时真正装载音频；autoplay 由触发方预先写入 requestAutoplayRef。
  useEffect(() => {
    if (!currentId || loadedIdRef.current === currentId) return;
    loadedIdRef.current = currentId;
    const track = currentRef.current;
    if (!track || track.id !== currentId) return;
    const shouldPlay = requestAutoplayRef.current;
    requestAutoplayRef.current = false;
    const audio = audioRef.current;
    if (audio) audio.pause();
    ambientRef.current?.stop();
    setPlaying(false);
    playingRef.current = false;
    setProgress(0);
    progressRef.current = 0;
    endedGuardRef.current = false;
    if (shouldPlay) startPlayback();
  }, [currentId, startPlayback]);

  // 播放期间用 rAF 平滑进度并驱动频响涟漪；暂停时只维持 0.05 的呼吸底噪。
  useEffect(() => {
    const stage = stageRef.current;
    if (!playing) {
      stage?.style.setProperty("--level", "0.04");
      return;
    }
    let frame = 0;
    let lastSync = 0;
    const paint = (time: number): void => {
      const track = currentRef.current;
      let level = 0.08;
      if (track?.source === "local") {
        const analyser = localAnalyserRef.current;
        level = analyser
          ? analyserLevel(analyser.analyser, analyser.data)
          : 0.26;
      } else {
        level = ambientRef.current?.level() ?? 0;
      }
      stage?.style.setProperty("--level", Math.max(0.045, level).toFixed(3));
      if (time - lastSync > 70) {
        lastSync = time;
        if (track?.source === "local" && !scrubRef.current) {
          const audio = audioRef.current;
          if (audio) {
            setProgress(audio.currentTime);
            progressRef.current = audio.currentTime;
          }
        } else if (track?.source === "online" && !scrubRef.current) {
          const clock = onlineClockRef.current;
          const elapsed =
            clock.offset + (performance.now() - clock.startedAt) / 1000;
          const total = track.duration;
          if (total > 0 && elapsed >= total) {
            if (!endedGuardRef.current) {
              endedGuardRef.current = true;
              handleEndedRef.current();
            }
          } else {
            const value = Math.max(0, elapsed);
            setProgress(value);
            progressRef.current = value;
          }
        }
      }
      frame = window.requestAnimationFrame(paint);
    };
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [playing]);

  // 把当前播放行平滑吸附到可视区，避免长列表里选中后还要手动滚。
  useEffect(() => {
    if (!drawerOpen || !current || current.source !== tab) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-track-id="${current.id}"]`,
    );
    row?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current, drawerOpen, tab]);

  // 全局快捷键：空格播放 / 暂停，Shift + 左右切歌，左右快退 / 快进，M 静音。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        setDrawer(false);
        return;
      }
      const target = event.target;
      if (
        target instanceof HTMLElement &&
        target.closest(
          "button, a, input, textarea, select, [role='button'], [role='slider'], [role='tab'], [contenteditable='true']",
        )
      ) {
        return;
      }
      if (event.key === " " || event.code === "Space") {
        event.preventDefault();
        togglePlayback();
      } else if (event.key === "ArrowRight" && event.shiftKey) {
        event.preventDefault();
        moveTrack(1);
      } else if (event.key === "ArrowLeft" && event.shiftKey) {
        event.preventDefault();
        moveTrack(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        seekRelative(SEEK_STEP_SECONDS);
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        seekRelative(-SEEK_STEP_SECONDS);
      } else if (event.key.toLowerCase() === "m") {
        toggleMute();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [moveTrack, seekRelative, setDrawer, toggleMute, togglePlayback]);

  useEffect(
    () => () => {
      for (const url of objectUrlsRef.current) URL.revokeObjectURL(url);
      objectUrlsRef.current = [];
      ambientRef.current?.dispose();
      ambientRef.current = null;
      const context = localAnalyserRef.current?.context ?? uiContextRef.current;
      localAnalyserRef.current = null;
      uiContextRef.current = null;
      if (context) {
        void context.close().catch(() => {});
      }
      if (noticeTimerRef.current !== null) {
        window.clearTimeout(noticeTimerRef.current);
        noticeTimerRef.current = null;
      }
      if (drawerWidthTimerRef.current !== null) {
        window.clearTimeout(drawerWidthTimerRef.current);
        drawerWidthTimerRef.current = null;
      }
    },
    [],
  );

  const timeText = formatClock(displayProgress);
  const durationText = formatTrackDuration(duration);
  const listTotal = formatClock(totalDuration(tracks));
  const localEmpty = tab === "local" && tracks.length === 0;
  const activeAllowed = current !== null && current.source === tab;
  const orbLabel = current
    ? `${playing ? "暂停" : "播放"}：${current.title}，${current.artist}`
    : "播放";
  const nextDockSide: DockSide = dockSide === "right" ? "left" : "right";
  const dockSideLabel =
    nextDockSide === "left" ? "曲库改从左侧弹出" : "曲库改从右侧弹出";
  // 换边时抽屉释放隐藏后，与主球组一起用 materialize 关键帧重组。
  const drawerEntering = dockSwitching && drawerOpen && !drawerHeld;

  return (
    <div
      ref={rootRef}
      className={`${styles.root} liquid-player-root`}
      style={rootStyle}
      data-theme={themeId}
      data-playing={playing ? "true" : "false"}
      data-drawer={drawerOpen ? "open" : "closed"}
      data-drawer-hold={drawerHeld ? "true" : "false"}
      data-drawer-entering={drawerEntering ? "true" : "false"}
      data-dock={dockSide}
      data-dock-leaving={dockLeaving ? "true" : "false"}
      data-dock-switching={dockSwitching ? "true" : "false"}
      data-source={tab}
      data-drop={dropActive ? "true" : "false"}
    >
      <main
        className={styles.stage}
        onDragEnter={onDragEnter}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
      >
        <section
          ref={playerClusterRef}
          className={styles.playerCluster}
          data-switching={dockSwitching ? "true" : "false"}
          aria-label="当前播放"
        >
          <div className={styles.orbColumn}>
            <div className={styles.topDock}>
              <div
                className={styles.dragHandle}
                data-tauri-drag-region="deep"
                title="拖动窗口"
              >
                <span className={styles.grip} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
                <span className={styles.dockBrand}>
                  <strong>Lull</strong>
                  <em>Liquid Vinyl</em>
                </span>
              </div>
              <span className={styles.dockDivider} aria-hidden="true" />
              <div className={styles.dockControls}>
                <button
                  type="button"
                  className={styles.dockButton}
                  aria-label={dockSideLabel}
                  aria-busy={dockBusy || dockSwitching}
                  title={dockSideLabel}
                  disabled={dockBusy || dockSwitching}
                  onClick={() => {
                    changeDockSide(nextDockSide);
                  }}
                >
                  <ChevronsLeftRight aria-hidden="true" />
                </button>
                {canMinimize ? (
                  <button
                    type="button"
                    className={styles.dockButton}
                    aria-label="最小化"
                    title="最小化"
                    onClick={() => {
                      void widgetMinimizeWindow();
                    }}
                  >
                    <Minus />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.dockButton}
                  aria-label="关闭窗口"
                  title="关闭（隐藏到托盘）"
                  onClick={() => {
                    void widgetHideWindow();
                  }}
                >
                  <X />
                </button>
              </div>
            </div>

            <div
              ref={stageRef}
              className={styles.orbStage}
              data-scrubbing={scrubbing ? "true" : "false"}
              data-live={playing ? "true" : "false"}
            >
              <span className={styles.orbAura} aria-hidden="true" />
              <span className={styles.orbAuraInner} aria-hidden="true" />

              <div
                className={styles.ringLayer}
                role="slider"
                tabIndex={0}
                aria-label="播放进度"
                aria-valuemin={0}
                aria-valuemax={Math.max(1, Math.round(duration))}
                aria-valuenow={Math.round(displayProgress)}
                aria-valuetext={`${timeText} / ${durationText}`}
                onKeyDown={ringKeyDown}
              >
                <svg
                  className={styles.ring}
                  viewBox="0 0 380 380"
                  aria-hidden="true"
                  onPointerDown={ringPointerDown}
                  onPointerMove={ringPointerMove}
                  onPointerUp={endRingPointer}
                  onPointerCancel={endRingPointer}
                >
                  <defs>
                    <linearGradient
                      id={`${panelId}-arc`}
                      x1="0"
                      y1="0"
                      x2="1"
                      y2="1"
                    >
                      <stop offset="0%" stopColor="#a8f0ff" />
                      <stop offset="52%" stopColor="#ffffff" />
                      <stop offset="100%" stopColor={palette.accent} />
                    </linearGradient>
                  </defs>
                  <circle
                    className={styles.ringAura}
                    cx="190"
                    cy="190"
                    r="178"
                  />
                  <circle
                    className={styles.ringBase}
                    cx="190"
                    cy="190"
                    r="178"
                    pathLength={100}
                  />
                  <circle
                    className={styles.ringTicks}
                    cx="190"
                    cy="190"
                    r="178"
                    pathLength={100}
                    strokeDasharray="0.34 3.4"
                  />
                  <circle
                    className={styles.ringGlow}
                    cx="190"
                    cy="190"
                    r="178"
                    pathLength={100}
                    stroke={`url(#${panelId}-arc)`}
                    strokeDasharray={`${progressPercent} 100`}
                    transform="rotate(-90 190 190)"
                  />
                  <circle
                    className={styles.ringArc}
                    cx="190"
                    cy="190"
                    r="178"
                    pathLength={100}
                    stroke={`url(#${panelId}-arc)`}
                    strokeDasharray={`${progressPercent} 100`}
                    transform="rotate(-90 190 190)"
                  />
                  <g transform={`rotate(${knobAngle} 190 190)`}>
                    <circle
                      className={styles.knobHalo}
                      cx="190"
                      cy="12"
                      r="12"
                    />
                    <circle
                      className={styles.knobRing}
                      cx="190"
                      cy="12"
                      r="5.4"
                    />
                    <circle
                      className={styles.knobCore}
                      cx="190"
                      cy="12"
                      r="2.4"
                    />
                    <path
                      className={styles.knobSpark}
                      d="M190 4.6v14.8M182.6 12h14.8"
                    />
                  </g>
                  <circle
                    className={styles.ringHit}
                    cx="190"
                    cy="190"
                    r="178"
                    pathLength={100}
                    strokeWidth="32"
                  />
                </svg>

                <div
                  className={styles.scrubBubble}
                  data-visible={scrubbing ? "true" : "false"}
                  style={{
                    left: `${scrubBubbleX}%`,
                    top: `${scrubBubbleY}%`,
                  }}
                  aria-hidden="true"
                >
                  {timeText}
                </div>
              </div>

              <div className={styles.orbFloat}>
                <button
                  type="button"
                  className={styles.orbButton}
                  aria-label={orbLabel}
                  aria-pressed={playing}
                  onClick={togglePlayback}
                >
                  <span className={styles.orb}>
                    <span className={styles.orbCoverLayer} key={currentId}>
                      <CoverArt
                        tone={currentTone}
                        className={styles.orbCover}
                      />
                    </span>
                    <span className={styles.orbTone} aria-hidden="true" />
                    <span className={styles.orbGrooves} aria-hidden="true" />
                    <span className={styles.orbSheen} aria-hidden="true" />
                    <span className={styles.orbShade} aria-hidden="true" />
                    <span className={styles.orbWaves} aria-hidden="true">
                      <i />
                      <i />
                      <i />
                    </span>
                    {playing ? (
                      <span className={styles.orbCaustic} aria-hidden="true" />
                    ) : null}
                    {pulseKey > 0 ? (
                      <span
                        key={pulseKey}
                        className={styles.orbPulse}
                        aria-hidden="true"
                      />
                    ) : null}
                    <span className={styles.orbGlyph} aria-hidden="true">
                      {playing ? <Pause /> : <Play />}
                    </span>
                    <span className={styles.orbCaption}>
                      <span className={styles.orbTitle}>
                        {current?.title ?? "未选择音频"}
                      </span>
                      <span className={styles.orbArtist}>
                        {current?.artist ?? "从曲库导入本地音频"}
                      </span>
                    </span>
                  </span>
                  <span className={styles.orbRim} aria-hidden="true" />
                  <span className={styles.dissolveLayer} key={currentId}>
                    {DISSOLVE_ANGLES.map((angle, order) => (
                      <i
                        key={angle}
                        style={
                          {
                            "--particle": order,
                            "--angle": `${angle}deg`,
                          } as CSSProperties
                        }
                      />
                    ))}
                  </span>
                </button>
              </div>

              <section className={styles.modeRail} aria-label="播放模式">
                {PLAY_MODE_OPTIONS.map((option, index) => {
                  const Icon = MODE_GLYPHS[option.id];
                  const active = mode === option.id;
                  const angle =
                    ((MODE_ARC_ANGLES[index] ?? MODE_ARC_ANGLES[1]) * Math.PI) /
                    180;
                  const arcX = Math.cos(angle) * MODE_ARC_RADIUS;
                  const arcY = Math.sin(angle) * MODE_ARC_RADIUS;
                  const x =
                    ORB_CENTER_IN_STAGE +
                    (dockSide === "right" ? arcX : -arcX) -
                    MODE_BUBBLE_HALF;
                  const y = ORB_CENTER_IN_STAGE + arcY - MODE_BUBBLE_HALF;
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={styles.modeBubble}
                      style={{ left: `${x}px`, top: `${y}px` }}
                      data-active={active ? "true" : "false"}
                      aria-label={option.label}
                      aria-pressed={active}
                      title={option.label}
                      onClick={() => chooseMode(option.id)}
                    >
                      <span className={styles.modeHalo} aria-hidden="true" />
                      <Icon aria-hidden="true" />
                      <span className={styles.modeLabel} aria-hidden="true">
                        {option.label}
                      </span>
                    </button>
                  );
                })}
              </section>

              <div className={styles.timeRow}>
                <button
                  type="button"
                  className={styles.skipButton}
                  aria-label="上一首"
                  title="上一首"
                  disabled={!canSkip}
                  onClick={() => moveTrack(-1)}
                >
                  <ChevronLeft />
                </button>
                <div className={styles.timeReadout}>
                  <span className={styles.timeCurrent}>{timeText}</span>
                  <span className={styles.timeSlash}>/</span>
                  <span className={styles.timeTotal}>{durationText}</span>
                </div>
                <button
                  type="button"
                  className={styles.skipButton}
                  aria-label="下一首"
                  title="下一首"
                  disabled={!canSkip}
                  onClick={() => moveTrack(1)}
                >
                  <ChevronRight />
                </button>
              </div>

              <section className={styles.volumeDock} aria-label="播放器音量">
                <button
                  type="button"
                  className={styles.volumeMute}
                  aria-label={volume > 0 ? "静音" : "取消静音"}
                  title={volume > 0 ? "静音（M）" : "取消静音（M）"}
                  onClick={toggleMute}
                >
                  {volume > 0 ? <Volume2 /> : <VolumeX />}
                </button>
                <div
                  ref={volumeTrackRef}
                  className={styles.volumeTrack}
                  role="slider"
                  tabIndex={0}
                  aria-label="音量"
                  aria-orientation="horizontal"
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={volume}
                  aria-valuetext={`${volume}%`}
                  onPointerDown={volumePointerDown}
                  onPointerMove={volumePointerMove}
                  onPointerUp={volumePointerEnd}
                  onPointerCancel={volumePointerEnd}
                  onKeyDown={volumeKeyDown}
                >
                  <span className={styles.volumeLine} aria-hidden="true" />
                  <span
                    className={styles.volumeFill}
                    style={{ width: `${volume}%` }}
                    aria-hidden="true"
                  />
                  <span
                    className={styles.volumeThumb}
                    style={{ left: `${volume}%` }}
                    aria-hidden="true"
                  />
                </div>
                <span className={styles.volumeValue}>{volume}</span>
              </section>
            </div>

            <button
              type="button"
              className={styles.libraryBubble}
              data-active={drawerOpen ? "true" : "false"}
              aria-label="曲库"
              aria-expanded={drawerOpen}
              aria-controls={panelId}
              title={drawerOpen ? "收起曲库" : "展开曲库"}
              disabled={dockBusy}
              onClick={toggleDrawer}
            >
              <span className={styles.libraryHalo} aria-hidden="true" />
              <FolderOpen aria-hidden="true" />
              <span>曲库</span>
            </button>
          </div>
        </section>

        <aside
          ref={drawerSlotRef}
          className={styles.drawerSlot}
          aria-label="曲库抽屉"
          inert={!drawerOpen || drawerHeld}
        >
          <section className={styles.drawer}>
            <header className={styles.drawerHead}>
              <div
                className={styles.sourcePill}
                role="tablist"
                aria-label="曲库来源"
              >
                <span
                  className={styles.sourceLiquid}
                  data-at={tab}
                  aria-hidden="true"
                />
                <button
                  ref={localTabRef}
                  type="button"
                  role="tab"
                  className={styles.sourceTab}
                  data-active={tab === "local" ? "true" : "false"}
                  aria-selected={tab === "local"}
                  aria-controls={panelId}
                  id={`${panelId}-local`}
                  onClick={() => switchTab("local")}
                  onKeyDown={onTabKeyDown}
                >
                  <HardDrive aria-hidden="true" />
                  本地
                </button>
                <button
                  ref={onlineTabRef}
                  type="button"
                  role="tab"
                  className={styles.sourceTab}
                  data-active={tab === "online" ? "true" : "false"}
                  aria-selected={tab === "online"}
                  aria-controls={panelId}
                  id={`${panelId}-online`}
                  onClick={() => switchTab("online")}
                  onKeyDown={onTabKeyDown}
                >
                  <Cloud aria-hidden="true" />
                  在线
                </button>
              </div>
              {tab === "local" ? (
                <button
                  type="button"
                  className={styles.drawerAdd}
                  aria-label="添加本地音频"
                  title="添加本地音频"
                  onClick={openFilePicker}
                >
                  <Plus />
                </button>
              ) : (
                <span className={styles.drawerLive} title="内置实时合成">
                  <AudioLines aria-hidden="true" />
                </span>
              )}
            </header>

            <div
              ref={listRef}
              className={styles.listScroll}
              id={panelId}
              role="tabpanel"
              aria-labelledby={`${panelId}-${tab}`}
            >
              {localEmpty ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon} aria-hidden="true">
                    <Upload />
                  </span>
                  <strong>本地曲库还空着</strong>
                  <p>拖入音频文件，或从电脑中选择</p>
                  <button
                    type="button"
                    className={styles.emptyAction}
                    onClick={openFilePicker}
                  >
                    <Plus aria-hidden="true" />
                    导入音频
                  </button>
                </div>
              ) : (
                <ul className={styles.trackList} key={tab}>
                  {visibleTracks.map((track) => {
                    const active = activeAllowed && track.id === current?.id;
                    const durationLabel = formatTrackDuration(track.duration);
                    return (
                      <li key={track.id}>
                        <button
                          type="button"
                          className={styles.trackRow}
                          data-active={active ? "true" : "false"}
                          data-playing={active && playing ? "true" : "false"}
                          data-track-id={track.id}
                          aria-label={`${track.title}，${track.artist}，${durationLabel}`}
                          aria-current={active ? "true" : undefined}
                          onClick={() => selectTrack(track, true)}
                        >
                          <span className={styles.rowGlow} aria-hidden="true" />
                          <span className={styles.rowCover} aria-hidden="true">
                            <CoverArt
                              tone={track.tone}
                              className={styles.rowCoverArt}
                            />
                            {active && playing ? (
                              <span className={styles.rowEq} aria-hidden="true">
                                <i />
                                <i />
                                <i />
                              </span>
                            ) : null}
                          </span>
                          <span className={styles.rowText}>
                            <strong title={track.title}>{track.title}</strong>
                            <em title={track.artist}>{track.artist}</em>
                          </span>
                          <span className={styles.rowMeta}>
                            {track.duration > 0 ? (
                              <span>{durationLabel}</span>
                            ) : (
                              <LoaderCircle
                                className={styles.rowSpinner}
                                aria-hidden="true"
                              />
                            )}
                          </span>
                        </button>
                      </li>
                    );
                  })}
                </ul>
              )}
            </div>

            <footer className={styles.drawerFoot}>
              <div className={styles.footNote}>
                {tab === "online" ? (
                  <>
                    <span className={styles.footDot} aria-hidden="true" />
                    实时合成 · 无需联网
                  </>
                ) : (
                  <>
                    <span className={styles.footDot} aria-hidden="true" />
                    {tracks.length} 首 · {listTotal}
                  </>
                )}
              </div>
            </footer>
          </section>
        </aside>
      </main>

      {/* 与白噪音同款换边光雾：从点击开始升起，覆盖窗口移动与布局翻转。 */}
      <span
        className={styles.switchVeil}
        data-active={dockVeil ? "true" : "false"}
        aria-hidden="true"
      />

      {notice ? (
        <output className={styles.srOnly} aria-live="polite">
          {notice}
        </output>
      ) : null}

      {dropActive ? (
        <div className={styles.dropOverlay} aria-hidden="true">
          <span>
            <Upload />
          </span>
          <strong>松开以加入本地曲库</strong>
          <p>支持 MP3 / WAV / FLAC / OGG / M4A</p>
        </div>
      ) : null}

      <input
        ref={inputRef}
        type="file"
        accept="audio/*,.mp3,.wav,.flac,.ogg,.oga,.m4a,.aac,.opus,.webm,.aiff,.aif"
        multiple
        hidden
        onChange={onFileInputChange}
      />

      {/* biome-ignore lint/a11y/useMediaCaption: 用户自选的本地音频，没有可预置的字幕轨道 */}
      <audio
        ref={audioRef}
        className={styles.srOnly}
        src={
          current?.source === "local" && current.url ? current.url : undefined
        }
        preload="metadata"
        onLoadedMetadata={(event) => {
          const audio = event.currentTarget;
          const track = currentRef.current;
          if (track?.source === "local" && Number.isFinite(audio.duration)) {
            updateTrackDuration(track.id, audio.duration);
          }
        }}
        onTimeUpdate={(event) => {
          if (currentRef.current?.source !== "local" || scrubRef.current) {
            return;
          }
          const value = event.currentTarget.currentTime;
          setProgress(value);
          progressRef.current = value;
        }}
        onPlay={() => {
          setPlaying(true);
          playingRef.current = true;
        }}
        onEnded={() => {
          if (currentRef.current?.source !== "local") return;
          if (endedGuardRef.current) return;
          endedGuardRef.current = true;
          handleEndedRef.current();
        }}
        onError={() => {
          if (currentRef.current?.source !== "local") return;
          showNotice("这个音频格式无法播放");
        }}
      />

      <p className={styles.srOnly} aria-live="polite">
        {current
          ? `${current.title}，${current.artist}，${playing ? "正在播放" : "已暂停"}`
          : "未选择音频"}
      </p>
    </div>
  );
}
