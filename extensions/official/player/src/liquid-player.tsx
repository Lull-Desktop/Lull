/**
 * LiquidPlayer（液态黑胶播放器）：把本地音频播放入口重构成参考稿里的水晶玻璃浮窗。
 *
 * 主球负责封面、播放 / 暂停、频响涟漪与进度环拖拽；左侧三颗循环泡切换播放模式，
 * 右侧水幕抽屉承载「曲库 / 队列」：曲库只展示 Media Service 扫描到的本地曲目，队列按播放顺序展示。
 */
"use client";

import {
  DEFAULT_SMART_SHUFFLE_CONFIG,
  type DirectoryEntry,
  type SmartShuffleConfig,
  type TrackSummary,
} from "@lull/media-sdk";
import {
  useDirectoryBrowser,
  useMediaClient,
  usePlayerSession,
} from "@lull/media-sdk/react";
import {
  ArrowLeft,
  ChevronLeft,
  ChevronRight,
  ChevronsLeftRight,
  Crosshair,
  FolderOpen,
  Heart,
  Library,
  ListMusic,
  LoaderCircle,
  Minus,
  Pause,
  Play,
  Plus,
  Repeat1,
  Repeat2,
  Settings,
  Shuffle,
  SlidersHorizontal,
  Upload,
  Volume2,
  VolumeX,
  X,
} from "lucide-react";
import type {
  CSSProperties,
  DragEvent,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
} from "react";
import {
  memo,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  isWidgetAudioAvailable,
  onLibraryState,
  onWidgetPrefsChanged,
  useWidgetFit,
  useWidgetTheme,
  widgetAlignPlayer,
  widgetCloseLibrary,
  widgetHideWindow,
  widgetIsMinimizable,
  widgetLibraryVisible,
  widgetMinimizeWindow,
  widgetOpenLibrary,
  widgetResizeWidth,
} from "./compat";
import { CoverArt } from "./cover-art";
import styles from "./liquid-player.module.css";
import {
  clampVolume,
  coverPalette,
  coverToneForText,
  findTrackById,
  formatClock,
  formatTrackDuration,
  PLAY_MODE_OPTIONS,
  type PlayerTrack,
  type PlayMode,
  persistPlayerPrefs,
  playModeLabel,
  readPlayerPrefs,
  totalDuration,
} from "./player-model";
import { SmartShufflePanel } from "./smart-shuffle-panel";
import { TipHost, tip } from "./tooltip";

/** Media Service 的 TrackSummary → 现有玻璃 UI 的 PlayerTrack。 */
function toPlayerTrack(track: TrackSummary): PlayerTrack {
  return {
    id: track.id,
    title: track.title,
    artist: track.artists.join(" / ") || "未知艺术家",
    duration: (track.durationMs ?? 0) / 1000,
    favorite: track.favorite === true,
    hasCover: track.hasCover,
    tone: coverToneForText(track.id),
  };
}
const SEEK_STEP_SECONDS = 5;
/** 收藏列表单页条数；滚动到底部时继续翻页。 */
const FAVORITES_PAGE_SIZE = 100;
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
/** 喜欢泡延续同一弧度、同一半径向下 18°，与三个模式泡等距。 */
const LIKE_ARC_ANGLE = 170;
/** 曲库 / 音乐库管理泡落在同一条弧上，角度取左侧 224° / 206° 的镜像，
 *  与对面「循环 / 随机」两泡等高，整圈视觉对称。 */
const LIBRARY_ARC_ANGLE = 316;
const LIBRARY_MANAGE_ARC_ANGLE = 334;
const MODE_ARC_RADIUS = 184;
/** 泡半径：必须与 CSS 的 --bubble-size 一半保持一致。 */
const MODE_BUBBLE_HALF = 22;
const ORB_CENTER_IN_STAGE = 148;
type DockSide = "left" | "right";
type DrawerTab = "library" | "queue" | "favorites";
/** 播放器能主动定位的音乐库页签，取值与 library-window 的 LibraryTab 一致。 */
type LibraryTarget = "queue" | "favorites" | "folders";
/** 页签的展示顺序；键盘左右键沿这个顺序循环。 */
const DRAWER_TAB_ORDER: readonly DrawerTab[] = [
  "library",
  "queue",
  "favorites",
];

/**
 * 环绕主球的泡位换算：所有圆泡（模式、喜欢、曲库、音乐库管理）共用同一条
 * 半径弧，停靠在哪一侧就沿 x 轴镜像，保证左右两列按钮围着主球对称。
 */
function arcBubbleOffset(
  angleDeg: number,
  side: DockSide,
): { left: number; top: number } {
  const angle = (angleDeg * Math.PI) / 180;
  const arcX = Math.cos(angle) * MODE_ARC_RADIUS;
  const arcY = Math.sin(angle) * MODE_ARC_RADIUS;
  return {
    left:
      ORB_CENTER_IN_STAGE +
      (side === "right" ? arcX : -arcX) -
      MODE_BUBBLE_HALF,
    top: ORB_CENTER_IN_STAGE + arcY - MODE_BUBBLE_HALF,
  };
}

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
const DISSOLVE_ANGLES = [
  0, 30, 60, 90, 120, 150, 180, 210, 240, 270, 300, 330,
] as const;

function resolveAudioContextCtor(): typeof AudioContext | null {
  if (typeof window === "undefined") return null;
  return (
    window.AudioContext ??
    (window as unknown as { webkitAudioContext?: typeof AudioContext })
      .webkitAudioContext ??
    null
  );
}

const rowCoverCache = new Map<string, string | null>();
const coverLoaders = new WeakMap<Element, () => void>();
let coverObserver: IntersectionObserver | null = null;

/** 所有行共享一个 observer，避免 200+ 行各建一个 IntersectionObserver。 */
function observeCover(element: Element, load: () => void): () => void {
  if (typeof IntersectionObserver === "undefined") {
    load();
    return () => {};
  }
  if (!coverObserver) {
    coverObserver = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const callback = coverLoaders.get(entry.target);
        if (!callback) continue;
        coverLoaders.delete(entry.target);
        coverObserver?.unobserve(entry.target);
        callback();
      }
    });
  }
  coverLoaders.set(element, load);
  coverObserver.observe(element);
  return () => {
    coverLoaders.delete(element);
    coverObserver?.unobserve(element);
  };
}

/**
 * 列表缩略图：有封面才请求 `getCoverUrl`，并用 IntersectionObserver 延迟到
 * 行进入视口；没有封面保持原来的 SVG 封面。请求结果按 trackId 缓存。
 */
function TrackCover({
  track,
  active,
  playing,
  getCoverUrl,
}: {
  track: PlayerTrack;
  active: boolean;
  playing: boolean;
  getCoverUrl: (trackId: string) => Promise<string | null>;
}): React.ReactElement {
  const [imageUrl, setImageUrl] = useState<string | null>(
    () => rowCoverCache.get(track.id) ?? null,
  );
  const hostRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const cached = rowCoverCache.get(track.id);
    // 行组件可能在页签切换时被复用；先切到当前 trackId 的缓存/空图。
    setImageUrl(cached ?? null);
    if (!track.hasCover) return;
    if (cached !== undefined) return;
    let alive = true;
    const load = (): void => {
      void getCoverUrl(track.id)
        .then((url) => {
          rowCoverCache.set(track.id, url);
          if (alive) setImageUrl(url);
        })
        .catch(() => {
          rowCoverCache.set(track.id, null);
          if (alive) setImageUrl(null);
        });
    };
    const node = hostRef.current;
    if (!node) {
      load();
      return () => {
        alive = false;
      };
    }
    const stopObserving = observeCover(node, load);
    return () => {
      alive = false;
      stopObserving();
    };
  }, [getCoverUrl, track.hasCover, track.id]);

  return (
    <span ref={hostRef} className={styles.rowCover} aria-hidden="true">
      <CoverArt
        tone={track.tone}
        className={styles.rowCoverArt}
        imageUrl={imageUrl}
      />
      {active && playing ? (
        <span className={styles.rowEq} aria-hidden="true">
          <i />
          <i />
          <i />
        </span>
      ) : null}
    </span>
  );
}

const TrackRow = memo(function TrackRow({
  track,
  active,
  selected,
  activePlaying,
  favorite,
  onSelect,
  getCoverUrl,
}: {
  track: PlayerTrack;
  active: boolean;
  selected: boolean;
  activePlaying: boolean;
  favorite: boolean;
  onSelect: (track: PlayerTrack) => void;
  getCoverUrl: (trackId: string) => Promise<string | null>;
}): React.ReactElement {
  const durationLabel = formatTrackDuration(track.duration);
  return (
    <li>
      <button
        type="button"
        className={styles.trackRow}
        data-active={active ? "true" : "false"}
        data-selected={selected ? "true" : "false"}
        data-playing={activePlaying ? "true" : "false"}
        data-track-id={track.id}
        aria-label={`${track.title}，${track.artist}，${durationLabel}${favorite ? "，已喜欢" : "，未喜欢"}`}
        aria-current={active ? "true" : undefined}
        onClick={() => onSelect(track)}
      >
        <span className={styles.rowGlow} aria-hidden="true" />
        <TrackCover
          track={track}
          active={active}
          playing={activePlaying}
          getCoverUrl={getCoverUrl}
        />
        <span className={styles.rowText}>
          <strong title={track.title}>{track.title}</strong>
          <em title={track.artist}>{track.artist}</em>
        </span>
        <span className={styles.rowMeta}>
          <Heart
            className={styles.rowHeart}
            data-liked={favorite ? "true" : "false"}
            fill={favorite ? "currentColor" : "none"}
            role="img"
            aria-label={favorite ? "已喜欢" : "未喜欢"}
          />
          {track.duration > 0 ? (
            <span>{durationLabel}</span>
          ) : (
            <LoaderCircle className={styles.rowSpinner} aria-hidden="true" />
          )}
        </span>
      </button>
    </li>
  );
});

const TrackList = memo(function TrackList({
  tracks,
  currentId,
  selectedId,
  playing,
  favoriteOverrides,
  onSelect,
  getCoverUrl,
}: {
  tracks: readonly PlayerTrack[];
  currentId: string | null;
  selectedId: string | null;
  playing: boolean;
  favoriteOverrides: Record<string, boolean>;
  onSelect: (track: PlayerTrack) => void;
  getCoverUrl: (trackId: string) => Promise<string | null>;
}): React.ReactElement {
  return (
    <ul className={styles.trackList}>
      {tracks.map((track) => {
        const active = track.id === currentId;
        return (
          <TrackRow
            key={track.id}
            track={track}
            active={active}
            selected={track.id === selectedId}
            activePlaying={active && playing}
            favorite={favoriteOverrides[track.id] ?? track.favorite === true}
            onSelect={onSelect}
            getCoverUrl={getCoverUrl}
          />
        );
      })}
    </ul>
  );
});

const DirectoryList = memo(function DirectoryList({
  directories,
  onEnter,
}: {
  directories: readonly DirectoryEntry[];
  onEnter: (entry: DirectoryEntry) => void;
}): React.ReactElement | null {
  if (directories.length === 0) return null;
  return (
    <ul className={styles.directoryList}>
      {directories.map((directory) => (
        <li key={`${directory.folderId}:${directory.path}`}>
          <button
            type="button"
            className={styles.directoryRow}
            onClick={() => onEnter(directory)}
            aria-label={`进入目录 ${directory.name}`}
          >
            <span className={styles.directoryIcon} aria-hidden="true">
              <FolderOpen />
            </span>
            <span className={styles.directoryText}>
              <strong>{directory.name}</strong>
              <em>{directory.trackCount} 首</em>
            </span>
            <ChevronRight aria-hidden="true" />
          </button>
        </li>
      ))}
    </ul>
  );
});

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
  const [tab, setTab] = useState<DrawerTab>("library");
  const [selectedId, setSelectedId] = useState("");
  const [currentId, setCurrentId] = useState("");
  const [playing, setPlaying] = useState(false);
  const [progress, setProgress] = useState(0);
  const [mode, setMode] = useState<PlayMode>("sequence");
  const [volume, setVolume] = useState(78);
  const [muted, setMuted] = useState(false);
  const [lastAudibleVolume, setLastAudibleVolume] = useState(78);
  const [drawerOpen, setDrawerOpen] = useState(true);
  const [drawerHeld, setDrawerHeld] = useState(false);
  // 音乐库窗口（状态监控）是否可见：由宿主推送校准，不靠本地猜测。
  const [libraryOpen, setLibraryOpen] = useState(false);
  // 库窗口当前停留的页签：同样来自宿主推送，用来区分「关闭」与「切页签」。
  const [libraryWindowTab, setLibraryWindowTab] = useState<string>("folders");
  const [dockSide, setDockSide] = useState<DockSide>("right");
  const [dockLeaving, setDockLeaving] = useState(false);
  const [dockSwitching, setDockSwitching] = useState(false);
  const [dockVeil, setDockVeil] = useState(false);
  const [dockBusy, setDockBusy] = useState(false);
  const [scrubbing, setScrubbing] = useState(false);
  const [scrubValue, setScrubValue] = useState(0);
  const [favoriteOverrides, setFavoriteOverrides] = useState<
    Record<string, boolean>
  >({});
  const [dropActive, setDropActive] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [pulseKey, setPulseKey] = useState(0);
  const [canMinimize, setCanMinimize] = useState(false);
  const [themeReady, setThemeReady] = useState(false);
  const [coverUrl, setCoverUrl] = useState<string | null>(null);
  // 智能随机配置由 Rust Media Service 持久化；本组件只缓存给设置面板用。
  const [smartConfig, setSmartConfig] = useState<SmartShuffleConfig>(
    DEFAULT_SMART_SHUFFLE_CONFIG,
  );
  const [smartOpen, setSmartOpen] = useState(false);
  // 收藏页：分页拉取，favorites.changed 事件触发重拉第一页。
  const [favoritesState, setFavoritesState] = useState<{
    tracks: PlayerTrack[];
    hasMore: boolean;
    total: number;
  }>({ tracks: [], hasMore: false, total: 0 });
  const [favoritesPage, setFavoritesPage] = useState(1);
  const [favoritesLoading, setFavoritesLoading] = useState(false);
  const [favoritesTick, setFavoritesTick] = useState(0);

  const session = usePlayerSession({ includeLibrary: false });
  const directory = useDirectoryBrowser();
  const mediaClient = useMediaClient();
  const directoryTracks = useMemo(
    () =>
      (directory.listing?.tracks.items ?? []).map((track) =>
        toPlayerTrack(track),
      ),
    [directory.listing],
  );
  const hostCurrentTrack = useMemo(
    () => (session.player?.track ? toPlayerTrack(session.player.track) : null),
    [session.player?.track],
  );
  const { themeId } = useWidgetTheme();
  const panelId = useId().replace(/[^a-zA-Z0-9_-]/g, "") || "tracklist";

  const rootRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const playerClusterRef = useRef<HTMLElement>(null);
  const drawerSlotRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const loadMoreSentinelRef = useRef<HTMLDivElement>(null);
  const scrollPositionsRef = useRef<Record<DrawerTab, number>>({
    library: 0,
    queue: 0,
    favorites: 0,
  });
  const pendingScrollRef = useRef<number | null>(null);
  const lastAutoScrolledIdRef = useRef<string | null>(null);
  const libraryTabRef = useRef<HTMLButtonElement>(null);
  const queueTabRef = useRef<HTMLButtonElement>(null);
  const favoritesTabRef = useRef<HTMLButtonElement>(null);

  const currentRef = useRef<PlayerTrack | null>(null);
  const currentIdRef = useRef("");
  const playerRef = useRef(session.player);
  const playingRef = useRef(false);
  const progressRef = useRef(0);
  const seekPendingRef = useRef(false);
  const volumeRef = useRef(78);
  const mutedRef = useRef(false);
  const serviceVolumeRef = useRef(-1);
  const scrubPointerRef = useRef<number | null>(null);
  const volumeTrackRef = useRef<HTMLDivElement>(null);
  const volumePointerRef = useRef<number | null>(null);
  const uiContextRef = useRef<AudioContext | null>(null);
  const noticeTimerRef = useRef<number | null>(null);
  const drawerWidthTimerRef = useRef<number | null>(null);
  const drawerOpenRef = useRef(true);
  const libraryOpenRef = useRef(false);
  const libraryWindowTabRef = useRef<string>("folders");
  const dockSideRef = useRef<DockSide>("right");
  const dockSwitchBusyRef = useRef(false);
  const dragDepthRef = useRef(0);
  const savedSmartRef = useRef<SmartShuffleConfig>(
    DEFAULT_SMART_SHUFFLE_CONFIG,
  );
  const smartConfigRef = useRef<SmartShuffleConfig>(smartConfig);
  const smartSaveTimerRef = useRef<number | null>(null);
  const smartSaveSeqRef = useRef(0);

  // 播放器是固定画布的透明浮窗：只需要等字体就绪后显示窗口，
  // 不能再按内容高度贴合（100vh 内容叠加顶栏高度会让窗口反复长高）。
  useWidgetFit(rootRef, { fit: false });

  useEffect(() => {
    smartConfigRef.current = smartConfig;
  }, [smartConfig]);

  useEffect(() => {
    let alive = true;
    void mediaClient.player
      .getSmartShuffleConfig()
      .then((config) => {
        if (!alive) return;
        savedSmartRef.current = config;
        setSmartConfig(config);
      })
      .catch(() => {
        // 读取失败时沿用默认值，不阻塞播放。
      });
    return () => {
      alive = false;
    };
  }, [mediaClient]);

  // 窗口销毁前尽力把最后一次滑杆修改写回后端。
  useEffect(
    () => () => {
      if (smartSaveTimerRef.current === null) return;
      window.clearTimeout(smartSaveTimerRef.current);
      smartSaveTimerRef.current = null;
      void mediaClient.player
        .setSmartShuffleConfig(smartConfigRef.current)
        .catch(() => {});
    },
    [mediaClient],
  );

  const allTracks = directoryTracks;
  const queueTracks = useMemo(
    () => session.queueTracks.map(toPlayerTrack),
    [session.queueTracks],
  );
  const favoritesTracks = favoritesState.tracks;
  const trackPool = useMemo(() => {
    const byId = new Map(allTracks.map((track) => [track.id, track]));
    for (const track of queueTracks) byId.set(track.id, track);
    if (hostCurrentTrack) byId.set(hostCurrentTrack.id, hostCurrentTrack);
    return [...byId.values()];
  }, [allTracks, hostCurrentTrack, queueTracks]);
  const current =
    findTrackById(trackPool, currentId) ?? hostCurrentTrack ?? null;
  const selectedTrack = findTrackById(trackPool, selectedId) ?? current ?? null;
  const favoriteOf = useCallback(
    (track: PlayerTrack | null): boolean =>
      track ? (favoriteOverrides[track.id] ?? track.favorite === true) : false,
    [favoriteOverrides],
  );
  const liked = favoriteOf(current);
  const likePos = arcBubbleOffset(LIKE_ARC_ANGLE, dockSide);
  const libraryPos = arcBubbleOffset(LIBRARY_ARC_ANGLE, dockSide);
  const managePos = arcBubbleOffset(LIBRARY_MANAGE_ARC_ANGLE, dockSide);
  const currentTone = current?.tone ?? 0;
  const palette = coverPalette(currentTone);
  const duration =
    current?.duration ||
    (session.player?.track?.id === current?.id
      ? (session.player?.durationMs ?? 0) / 1000
      : 0);
  const visibleTracks =
    tab === "queue"
      ? queueTracks
      : tab === "favorites"
        ? favoritesTracks
        : allTracks;
  const displayProgress = scrubbing ? scrubValue : progress;
  const progressRatio =
    duration > 0 ? Math.min(1, Math.max(0, displayProgress / duration)) : 0;
  const progressPercent = progressRatio * 100;
  const knobAngle = progressRatio * 360;
  const scrubAngle = progressRatio * Math.PI * 2 - Math.PI / 2;
  const scrubBubbleX = 50 + Math.cos(scrubAngle) * 46;
  const scrubBubbleY = 50 + Math.sin(scrubAngle) * 46;
  const listLength = visibleTracks.length;
  const canSkip = current !== null && listLength > 1;
  // 齿轮开关亮起判定：库窗口开着，且正停在对应页签上。
  const queueGearActive = libraryOpen && libraryWindowTab === "queue";
  const favoritesGearActive = libraryOpen && libraryWindowTab === "favorites";

  /**
   * 库窗口开关 + 页签的唯一状态入口：本地先生效，宿主推送回来再校准。
   * `tab` 缺省表示这次推送没带页签信息，只改可见性；带页签时照单收下
   * （库窗口可能停在播放器不认识的页签上，那样下次点击就按「切换」处理）。
   */
  const applyLibraryOpen = useCallback(
    (visible: boolean, tab?: string): void => {
      libraryOpenRef.current = visible;
      setLibraryOpen(visible);
      if (tab) {
        libraryWindowTabRef.current = tab;
        setLibraryWindowTab(tab);
      }
    },
    [],
  );

  /**
   * 库窗口状态同步：首帧问一次可见性，之后跟随宿主推送。
   * 用户直接关掉库窗口、在库窗口里切页签、或从托盘 / 设置页隐藏时都会更新，
   * 开关按钮的高亮与「再点一次是否关闭」的判断因此不会和真实窗口脱钩。
   */
  useEffect(() => {
    let alive = true;
    void widgetLibraryVisible().then((visible: boolean) => {
      if (alive) applyLibraryOpen(visible);
    });
    const stop = onLibraryState(({ visible, tab }) =>
      applyLibraryOpen(visible, tab),
    );
    return () => {
      alive = false;
      stop();
    };
  }, [applyLibraryOpen]);

  useEffect(() => {
    const trackId = current?.id;
    if (!trackId) {
      setCoverUrl(null);
      return;
    }
    setCoverUrl(null);
    let alive = true;
    void session
      .getCoverUrl(trackId)
      .then((url) => {
        if (alive) setCoverUrl(url);
      })
      .catch(() => {
        if (alive) setCoverUrl(null);
      });
    return () => {
      alive = false;
    };
  }, [current?.id, session.getCoverUrl]);

  // 收藏列表：首次挂载与 favorites.changed（favoritesTick）时重拉第一页。
  // biome-ignore lint/correctness/useExhaustiveDependencies: favoritesTick is the refetch trigger.
  useEffect(() => {
    let alive = true;
    setFavoritesLoading(true);
    void mediaClient.favorites
      .list(1, FAVORITES_PAGE_SIZE)
      .then((page) => {
        if (!alive) return;
        setFavoritesPage(1);
        setFavoritesState({
          tracks: page.items.map(toPlayerTrack),
          hasMore: page.hasMore,
          total: page.total,
        });
      })
      .catch(() => {
        if (alive) {
          setFavoritesState({ tracks: [], hasMore: false, total: 0 });
        }
      })
      .finally(() => {
        if (alive) setFavoritesLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [mediaClient, favoritesTick]);

  // 喜欢状态在任何窗口变化（本窗口心形、音乐库窗口）都会广播 favorites.changed。
  useEffect(
    () =>
      mediaClient.events.on((event) => {
        if (event.topic === "favorites.changed") {
          setFavoritesTick((value) => value + 1);
        }
      }),
    [mediaClient],
  );

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
    playerRef.current = session.player;
  }, [session.player]);

  useEffect(() => {
    playingRef.current = playing;
  }, [playing]);

  useEffect(() => {
    progressRef.current = progress;
  }, [progress]);

  useEffect(() => {
    volumeRef.current = volume;
    mutedRef.current = muted;
    if (volume > 0) setLastAudibleVolume(volume);
  }, [muted, volume]);

  // Rust Media Service 是播放状态的权威源；本组件只缓存给玻璃 UI 用。
  useEffect(() => {
    const player = session.player;
    if (!player) return;
    setCurrentId(player.track?.id ?? "");
    if (player.track?.id) setSelectedId(player.track.id);
    setPlaying(player.status === "playing" || player.status === "loading");
    if (!scrubbing && !seekPendingRef.current) {
      setProgress(player.positionMs / 1000);
      progressRef.current = player.positionMs / 1000;
    }
    setMode(player.mode);
    setMuted(player.muted);
    const nextVolume = Math.round(player.volume * 100);
    // 进度事件也会刷新 player 对象；只有服务端音量真的变化时才覆盖本地滑杆，
    // 避免用户拖动中的值被 500ms 一次的进度事件弹回去。
    if (serviceVolumeRef.current !== nextVolume) {
      serviceVolumeRef.current = nextVolume;
      setVolume(nextVolume);
      if (nextVolume > 0) setLastAudibleVolume(nextVolume);
    }
  }, [scrubbing, session.player]);

  // 队列页按 queue.trackIds 顺序展示。

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
    // 旧版本把“静音”持久化成 volume=0；新版本只用 muted，启动时忽略 0。
    if (stored.volume !== undefined && stored.volume > 0) {
      setVolume(stored.volume);
      setLastAudibleVolume(stored.volume);
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

  const persistSmartConfig = useCallback(
    (next: SmartShuffleConfig): void => {
      const seq = smartSaveSeqRef.current + 1;
      smartSaveSeqRef.current = seq;
      void mediaClient.player
        .setSmartShuffleConfig(next)
        .then((saved) => {
          savedSmartRef.current = saved;
          if (smartSaveSeqRef.current === seq) setSmartConfig(saved);
        })
        .catch(() => {
          if (smartSaveSeqRef.current !== seq) return;
          setSmartConfig(savedSmartRef.current);
          showNotice("智能随机设置保存失败");
        });
    },
    [mediaClient, showNotice],
  );

  const updateSmartConfig = useCallback(
    (next: SmartShuffleConfig): void => {
      setSmartConfig(next);
      if (smartSaveTimerRef.current !== null) {
        window.clearTimeout(smartSaveTimerRef.current);
      }
      smartSaveTimerRef.current = window.setTimeout(() => {
        smartSaveTimerRef.current = null;
        persistSmartConfig(next);
      }, 300);
    },
    [persistSmartConfig],
  );

  /** 关闭面板/切换模式时立即落盘，避免防抖窗口内的修改丢失。 */
  const flushSmartConfig = useCallback((): void => {
    if (smartSaveTimerRef.current === null) return;
    window.clearTimeout(smartSaveTimerRef.current);
    smartSaveTimerRef.current = null;
    persistSmartConfig(smartConfigRef.current);
  }, [persistSmartConfig]);

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

  /** 切歌时一声很轻的水滴「啵」，与 0.35s 封面晕染同步。 */
  const playDropSound = useCallback((): void => {
    if (volumeRef.current <= 0 || mutedRef.current) return;
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

  const pausePlayback = useCallback((): void => {
    setPlaying(false);
    playingRef.current = false;
    setPulseKey((value) => value + 1);
    void session.actions.pause().catch(() => {});
  }, [session.actions]);

  const startPlayback = useCallback((): void => {
    const track = currentRef.current;
    if (!track) {
      setDrawer(true);
      showNotice("先从曲库选择一首音频");
      return;
    }
    setPlaying(true);
    playingRef.current = true;
    setPulseKey((value) => value + 1);
    if (progressRef.current >= Math.max(0, track.duration - 0.25)) {
      setProgress(0);
      progressRef.current = 0;
    }
    const player = playerRef.current;
    const resumable =
      player?.track?.id === track.id &&
      player.positionMs > 0 &&
      player.status !== "idle";
    const action = resumable
      ? session.actions.resume
      : () => session.actions.play(track.id);
    void action().catch(() => {
      setPlaying(false);
      playingRef.current = false;
      showNotice("音频播放失败，请重试");
    });
  }, [session.actions, setDrawer, showNotice]);

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
      currentRef.current = track;
      currentIdRef.current = track.id;
      setCurrentId(track.id);
      setSelectedId(track.id);
      setProgress(0);
      progressRef.current = 0;
      setPulseKey((value) => value + 1);
      if (wasPlaying) playDropSound();
      if (autoplay) {
        setPlaying(true);
        playingRef.current = true;
        void session.actions.play(track.id).catch(() => {
          setPlaying(false);
          playingRef.current = false;
          showNotice("音频播放失败，请重试");
        });
      } else if (wasPlaying) {
        void session.actions.pause().catch(() => {});
      }
    },
    [playDropSound, session.actions, showNotice, startPlayback],
  );

  const handleSelectTrack = useCallback(
    (track: PlayerTrack): void => {
      selectTrack(track, true);
    },
    [selectTrack],
  );

  const scrollTrackIntoView = useCallback(
    (trackId: string, block: "nearest" | "center" = "nearest"): void => {
      const row = listRef.current?.querySelector<HTMLElement>(
        `[data-track-id="${trackId}"]`,
      );
      row?.scrollIntoView({ block, behavior: "smooth" });
    },
    [],
  );

  const moveTrack = useCallback(
    (direction: 1 | -1): void => {
      // 随机播放的选曲完全由 Rust Media Service 决定（当前页签列表通过
      // setAdvanceList 同步过去）；前端只发「下一首 / 上一首」意图，避免
      // 再维护一套 Math.random 选曲。
      if (mode === "shuffle") {
        const action =
          direction > 0 ? session.actions.next : session.actions.previous;
        void action()
          .then(() => {
            playDropSound();
            setPulseKey((value) => value + 1);
          })
          .catch(() => showNotice("没有可播放的曲目"));
        return;
      }
      const list = visibleTracks;
      if (list.length === 0) {
        showNotice(tab === "queue" ? "播放队列为空" : "曲库为空");
        return;
      }
      const index = list.findIndex(
        (track) => track.id === currentIdRef.current,
      );
      // 当前曲目不在当前列表（例如从另一页签播放）时，下一首从表头开始，
      // 上一首从表尾开始；否则沿当前页签的列表顺序循环。
      let target: PlayerTrack | undefined;
      if (index < 0) {
        target = direction > 0 ? list[0] : list[list.length - 1];
      } else {
        target = list[(index + direction + list.length) % list.length];
      }
      if (!target) return;
      selectTrack(target, true);
    },
    [
      mode,
      playDropSound,
      selectTrack,
      session.actions,
      showNotice,
      tab,
      visibleTracks,
    ],
  );

  const commitSeek = useCallback(
    (value: number): void => {
      const track = currentRef.current;
      if (!track) return;
      const maximum = track.duration > 0 ? track.duration : value;
      const clamped = Math.min(maximum, Math.max(0, value));
      setProgress(clamped);
      progressRef.current = clamped;
      // Rust 侧 positionMs 是整数；ratio × duration 的浮点尾巴会被 as_i64 拒绝。
      // 等宿主确认 seek 前不要被 500ms 的旧进度事件拉回去。
      seekPendingRef.current = true;
      void session.actions
        .seek(Math.round(clamped * 1000))
        .catch(() => {})
        .finally(() => {
          seekPendingRef.current = false;
        });
    },
    [session.actions],
  );

  const seekRelative = useCallback(
    (delta: number): void => {
      commitSeek(progressRef.current + delta);
    },
    [commitSeek],
  );

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
    setScrubbing(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    commitSeek(progressRef.current);
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
    commitSeek(next);
  };

  const chooseMode = useCallback(
    (nextMode: PlayMode): void => {
      setMode(nextMode);
      showNotice(playModeLabel(nextMode));
      void session.actions.setMode(nextMode).catch(() => {});
    },
    [session.actions, showNotice],
  );

  const toggleFavorite = useCallback((): void => {
    if (!current) return;
    const trackId = current.id;
    const next = !liked;
    setFavoriteOverrides((previous) => ({
      ...previous,
      [trackId]: next,
    }));
    void session.actions
      .setFavorite(trackId, next)
      .then(() => showNotice(next ? "已喜欢" : "已取消喜欢"))
      .catch(() => {
        setFavoriteOverrides((previous) => {
          const restored = { ...previous };
          delete restored[trackId];
          return restored;
        });
        showNotice("喜欢操作失败");
      });
  }, [current, liked, session.actions, showNotice]);

  const switchTab = useCallback(
    (next: DrawerTab): void => {
      if (next === tab) return;
      const list = listRef.current;
      if (list) scrollPositionsRef.current[tab] = list.scrollTop;
      pendingScrollRef.current = scrollPositionsRef.current[next];
      setTab(next);
    },
    [tab],
  );

  /** 只由右侧瞄准按钮触发：当前曲目在当前列表里才滚动定位。 */
  const locateCurrentInList = useCallback((): void => {
    const track = current ?? currentRef.current;
    if (!track) {
      showNotice("当前没有播放曲目");
      return;
    }
    if (!visibleTracks.some((item) => item.id === track.id)) {
      showNotice("当前播放曲目不在当前列表");
      return;
    }
    setSelectedId(track.id);
    lastAutoScrolledIdRef.current = track.id;
    scrollTrackIntoView(track.id, "center");
  }, [current, scrollTrackIntoView, showNotice, visibleTracks]);

  const openFilePicker = useCallback((): void => {
    setTab("library");
    setDrawer(true);
    void session.actions
      .addSource()
      .then(() => showNotice("正在扫描音乐文件夹"))
      .catch(() => showNotice("添加音乐文件夹失败"));
  }, [session.actions, setDrawer, showNotice]);

  const addSelectedToQueue = useCallback((): void => {
    if (!selectedTrack) {
      showNotice("先选中一首曲目");
      return;
    }
    void session.actions
      .addToQueue(selectedTrack.id)
      .then(() => showNotice(`已加入队列：${selectedTrack.title}`))
      .catch(() => showNotice("加入队列失败"));
  }, [selectedTrack, session.actions, showNotice]);

  const toggleMute = useCallback((): void => {
    const silent = muted || volume <= 0;
    const next = !silent;
    setMuted(next);
    if (!next && volume <= 0) {
      const restored = Math.max(1, lastAudibleVolume);
      setVolume(restored);
      void session.actions.setVolume(restored / 100).catch(() => {});
    }
    void session.actions.setMuted(next).catch(() => {});
  }, [lastAudibleVolume, muted, session.actions, volume]);

  // 滑杆/滚轮只改本地 UI；停顿后再提交给服务，避免每像素一次 IPC。
  useEffect(() => {
    if (!session.player) return;
    const current = Math.round(session.player.volume * 100);
    if (current === volume) return;
    const timer = window.setTimeout(() => {
      void session.actions.setVolume(volume / 100).catch(() => {});
      if (volume > 0) {
        setMuted(false);
        void session.actions.setMuted(false).catch(() => {});
      }
    }, 120);
    return () => window.clearTimeout(timer);
  }, [session.actions, session.player, volume]);

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

  const openSmartSettings = useCallback((): void => {
    setDrawer(true);
    setSmartOpen(true);
  }, [setDrawer]);

  const closeSmartSettings = useCallback((): void => {
    flushSmartConfig();
    setSmartOpen(false);
  }, [flushSmartConfig]);

  const toggleDrawer = useCallback((): void => {
    if (drawerOpenRef.current && smartOpen) {
      flushSmartConfig();
      setSmartOpen(false);
    }
    setDrawer(!drawerOpenRef.current);
  }, [flushSmartConfig, setDrawer, smartOpen]);

  /**
   * 库窗口的开关（toggle）：目标页签已经开着就收起，否则打开 / 切到该页签。
   * 先乐观翻转按钮，失败则回滚；真实状态仍以宿主推送为准。
   */
  const toggleLibraryWindow = useCallback(
    (target: LibraryTarget): void => {
      const closing =
        libraryOpenRef.current && libraryWindowTabRef.current === target;
      if (closing) {
        applyLibraryOpen(false);
        void widgetCloseLibrary().catch(() => {
          applyLibraryOpen(true, target);
          showNotice("关闭音乐库窗口失败");
        });
        return;
      }
      // 新建窗口时宿主不会广播（窗口先隐藏、贴合内容后才显示），
      // 这里直接点亮按钮，与真实窗口保持一致。
      applyLibraryOpen(true, target);
      void widgetOpenLibrary(target).catch(() => {
        applyLibraryOpen(false);
        showNotice("打开音乐库窗口失败");
      });
    },
    [applyLibraryOpen, showNotice],
  );

  const loadMoreFavorites = useCallback((): void => {
    if (favoritesLoading || !favoritesState.hasMore) return;
    const next = favoritesPage + 1;
    setFavoritesLoading(true);
    void mediaClient.favorites
      .list(next, FAVORITES_PAGE_SIZE)
      .then((page) => {
        setFavoritesPage(next);
        setFavoritesState((previous) => ({
          tracks: [...previous.tracks, ...page.items.map(toPlayerTrack)],
          hasMore: page.hasMore,
          total: page.total,
        }));
      })
      .catch(() => {})
      .finally(() => {
        setFavoritesLoading(false);
      });
  }, [favoritesLoading, favoritesPage, favoritesState.hasMore, mediaClient]);

  const loadMoreLibrary = useCallback((): void => {
    const hasMore =
      tab === "library"
        ? Boolean(directory.listing?.tracks.hasMore) && !directory.loadingMore
        : tab === "favorites"
          ? favoritesState.hasMore && !favoritesLoading
          : false;
    if (!hasMore) return;
    const list = listRef.current;
    if (!list) return;
    const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
    if (remaining < 260) {
      if (tab === "library") void directory.loadMore();
      else loadMoreFavorites();
    }
  }, [
    directory.listing?.tracks.hasMore,
    directory.loadMore,
    directory.loadingMore,
    favoritesLoading,
    favoritesState.hasMore,
    loadMoreFavorites,
    tab,
  ]);

  // onScroll 在部分 WebView2/iframe 组合下不稳定；底部 sentinel 再兜一层。
  useEffect(() => {
    const hasMore =
      tab === "library"
        ? Boolean(directory.listing?.tracks.hasMore)
        : tab === "favorites"
          ? favoritesState.hasMore
          : false;
    if (!hasMore) return;
    const loadMore = tab === "library" ? directory.loadMore : loadMoreFavorites;
    const list = listRef.current;
    const sentinel = loadMoreSentinelRef.current;
    if (!list || !sentinel || typeof IntersectionObserver === "undefined") {
      return;
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void loadMore();
        }
      },
      { root: list, rootMargin: "0px 0px 280px 0px", threshold: 0 },
    );
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [
    tab,
    directory.listing?.tracks.hasMore,
    directory.loadMore,
    favoritesState.hasMore,
    loadMoreFavorites,
  ]);

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const index = DRAWER_TAB_ORDER.indexOf(tab);
    const offset = event.key === "ArrowRight" ? 1 : -1;
    const next =
      DRAWER_TAB_ORDER[
        (index + offset + DRAWER_TAB_ORDER.length) % DRAWER_TAB_ORDER.length
      ] ?? tab;
    switchTab(next);
    window.setTimeout(() => {
      const ref =
        next === "library"
          ? libraryTabRef
          : next === "queue"
            ? queueTabRef
            : favoritesTabRef;
      ref.current?.focus();
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
    showNotice("请使用「添加音乐文件夹」导入曲目");
  };

  // 频响电平由音频引擎 20Hz 上报；rAF 只写 CSS 变量，不触发 React 重渲染。
  useEffect(() => {
    const stage = stageRef.current;
    if (!playing) {
      stage?.style.setProperty("--level", "0.045");
      return;
    }
    let frame = 0;
    let lastPaint = 0;
    const paint = (time: number): void => {
      // 频响只为视觉服务，30fps 足够，避免每帧触发布局/合成。
      if (time - lastPaint >= 33) {
        lastPaint = time;
        const level = session.levelRef.current;
        stage?.style.setProperty("--level", Math.max(0.045, level).toFixed(3));
      }
      frame = window.requestAnimationFrame(paint);
    };
    frame = window.requestAnimationFrame(paint);
    return () => window.cancelAnimationFrame(frame);
  }, [playing, session.levelRef]);

  // 页签切换后在新列表 commit 完成、绘制前恢复滚动位置，避免先闪到顶部。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab/visibleTracks are the commit trigger.
  useLayoutEffect(() => {
    const target = pendingScrollRef.current;
    if (target === null) return;
    pendingScrollRef.current = null;
    const node = listRef.current;
    if (node) node.scrollTop = target;
  }, [tab, visibleTracks]);

  const directoryKey = `${directory.location.folderId ?? ""}:${directory.location.path}`;

  // 进入子目录 / 返回上级后从新列表顶部开始。
  // biome-ignore lint/correctness/useExhaustiveDependencies: directoryKey is the navigation trigger.
  useEffect(() => {
    listRef.current?.scrollTo?.({ top: 0 });
  }, [directoryKey]);

  // 播放曲目变化时定位（含上一首/下一首、播放结束自动切歌、点选行）。
  // 切换页签不会改变 current.id，因此不会覆盖页签滚动缓存。
  // biome-ignore lint/correctness/useExhaustiveDependencies: tab/visibleTracks retry once the row appears.
  useEffect(() => {
    if (!drawerOpen || !current) return;
    if (lastAutoScrolledIdRef.current === current.id) return;
    // 标记本次曲目变化，即使目标行还没加载/不在列表，也避免之后滚动
    // 缓存恢复或分页追加时突然抢走用户位置。
    lastAutoScrolledIdRef.current = current.id;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-track-id="${current.id}"]`,
    );
    if (!row) return;
    row.scrollIntoView({ block: "nearest", behavior: "smooth" });
  }, [current, drawerOpen, tab, visibleTracks]);

  // 宿主自然播完时按当前页签列表 + sequence/shuffle 选下一首。
  useEffect(() => {
    void session.actions
      .setAdvanceList(visibleTracks.map((track) => track.id))
      .catch(() => {});
  }, [session.actions, visibleTracks]);

  // 播放器窗口销毁后交还给宿主队列，避免关闭后仍用旧页签列表。
  useEffect(
    () => () => {
      void session.actions.setAdvanceList([]).catch(() => {});
    },
    [session.actions],
  );

  // 切出随机模式时收起设置面板，避免面板悬在别的模式上。
  useEffect(() => {
    if (mode !== "shuffle" && smartOpen) {
      flushSmartConfig();
      setSmartOpen(false);
    }
  }, [flushSmartConfig, mode, smartOpen]);

  // 全局快捷键：空格播放 / 暂停，Shift + 左右切歌，左右快退 / 快进，M 静音。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape") {
        if (smartOpen) {
          closeSmartSettings();
          return;
        }
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
  }, [
    closeSmartSettings,
    moveTrack,
    seekRelative,
    setDrawer,
    smartOpen,
    toggleMute,
    togglePlayback,
  ]);

  useEffect(
    () => () => {
      const context = uiContextRef.current;
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
  const listTotal = formatClock(
    totalDuration(
      tab === "queue"
        ? queueTracks
        : tab === "favorites"
          ? favoritesTracks
          : allTracks,
    ),
  );
  const directoryCount = directory.listing?.directories.length ?? 0;
  const libraryTotal = directory.listing?.tracks.total ?? 0;
  const atDirectoryRoot = directory.location.folderId === null;
  const listEmpty =
    (tab === "library" &&
      !directory.loading &&
      directoryCount === 0 &&
      allTracks.length === 0) ||
    (tab === "queue" && queueTracks.length === 0) ||
    (tab === "favorites" && !favoritesLoading && favoritesTracks.length === 0);
  const orbLabel = current
    ? `${playing ? "暂停" : "播放"}：${current.title}，${current.artist}`
    : "播放";
  const nextDockSide: DockSide = dockSide === "right" ? "left" : "right";
  const dockSideLabel =
    nextDockSide === "left" ? "曲库改从左侧弹出" : "曲库改从右侧弹出";
  const silent = muted || volume <= 0;
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
                {...tip("拖动窗口")}
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
                  {...tip(dockSideLabel)}
                  disabled={dockBusy || dockSwitching}
                  onClick={() => {
                    changeDockSide(nextDockSide);
                  }}
                >
                  <ChevronsLeftRight aria-hidden="true" />
                </button>
                {mode === "shuffle" ? (
                  <button
                    type="button"
                    className={styles.dockButton}
                    aria-label="智能随机设置"
                    aria-haspopup="dialog"
                    aria-expanded={smartOpen}
                    {...tip("智能随机设置")}
                    onClick={openSmartSettings}
                  >
                    <SlidersHorizontal aria-hidden="true" />
                  </button>
                ) : null}
                {canMinimize ? (
                  <button
                    type="button"
                    className={styles.dockButton}
                    aria-label="最小化"
                    {...tip("最小化")}
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
                  {...tip("关闭（隐藏到托盘）")}
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
                        imageUrl={coverUrl}
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

              <section className={styles.modeRail} aria-label="播放模式与喜欢">
                {PLAY_MODE_OPTIONS.map((option, index) => {
                  const Icon = MODE_GLYPHS[option.id];
                  const active = mode === option.id;
                  const pos = arcBubbleOffset(
                    MODE_ARC_ANGLES[index] ?? MODE_ARC_ANGLES[1],
                    dockSide,
                  );
                  return (
                    <button
                      key={option.id}
                      type="button"
                      className={styles.modeBubble}
                      style={{ left: `${pos.left}px`, top: `${pos.top}px` }}
                      data-active={active ? "true" : "false"}
                      aria-label={option.label}
                      aria-pressed={active}
                      {...tip(option.label)}
                      onClick={() => chooseMode(option.id)}
                    >
                      <span className={styles.modeHalo} aria-hidden="true" />
                      <Icon aria-hidden="true" />
                    </button>
                  );
                })}
                <button
                  type="button"
                  className={`${styles.modeBubble} ${styles.likeBubble}`}
                  style={{ left: `${likePos.left}px`, top: `${likePos.top}px` }}
                  data-active={liked ? "true" : "false"}
                  aria-label={liked ? "取消喜欢" : "喜欢"}
                  aria-pressed={liked}
                  {...tip(liked ? "取消喜欢" : "喜欢")}
                  onClick={toggleFavorite}
                >
                  <span className={styles.modeHalo} aria-hidden="true" />
                  <Heart
                    aria-hidden="true"
                    fill={liked ? "currentColor" : "none"}
                  />
                </button>
              </section>

              <div className={styles.timeRow}>
                <button
                  type="button"
                  className={styles.skipButton}
                  aria-label="上一首"
                  {...tip("上一首")}
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
                  {...tip("下一首")}
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
                  aria-label={silent ? "取消静音" : "静音"}
                  {...tip(silent ? "取消静音（M）" : "静音（M）")}
                  onClick={toggleMute}
                >
                  {silent ? <VolumeX /> : <Volume2 />}
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
              className={`${styles.modeBubble} ${styles.libraryBubble}`}
              style={{
                left: `${libraryPos.left}px`,
                top: `${libraryPos.top}px`,
              }}
              data-active={drawerOpen ? "true" : "false"}
              aria-label={drawerOpen ? "收起列表" : "展开列表"}
              aria-expanded={drawerOpen}
              aria-controls={panelId}
              {...tip(drawerOpen ? "收起列表" : "展开列表")}
              disabled={dockBusy}
              onClick={toggleDrawer}
            >
              <span className={styles.modeHalo} aria-hidden="true" />
              <FolderOpen aria-hidden="true" />
            </button>
            <button
              type="button"
              className={`${styles.modeBubble} ${styles.libraryManage}`}
              style={{ left: `${managePos.left}px`, top: `${managePos.top}px` }}
              data-active={libraryOpen ? "true" : "false"}
              aria-label="状态监控"
              aria-pressed={libraryOpen}
              {...tip(libraryOpen ? "关闭状态监控" : "打开状态监控")}
              disabled={dockBusy}
              onClick={() => toggleLibraryWindow("folders")}
            >
              <span className={styles.modeHalo} aria-hidden="true" />
              <Library aria-hidden="true" />
            </button>
          </div>
        </section>

        <aside
          ref={drawerSlotRef}
          className={styles.drawerSlot}
          aria-label={smartOpen ? "智能随机设置" : "曲库抽屉"}
          inert={!drawerOpen || drawerHeld}
        >
          {smartOpen ? (
            <SmartShufflePanel
              config={smartConfig}
              onChange={updateSmartConfig}
              onClose={closeSmartSettings}
              onNotice={showNotice}
            />
          ) : null}
          <section
            className={styles.drawer}
            style={smartOpen ? { display: "none" } : undefined}
          >
            <header className={styles.drawerHead}>
              <div
                className={styles.sourcePill}
                role="tablist"
                aria-label="曲库视图"
              >
                <span
                  className={styles.sourceLiquid}
                  data-at={tab}
                  aria-hidden="true"
                />
                <button
                  ref={libraryTabRef}
                  type="button"
                  role="tab"
                  className={styles.sourceTab}
                  data-active={tab === "library" ? "true" : "false"}
                  aria-selected={tab === "library"}
                  aria-controls={panelId}
                  id={`${panelId}-library`}
                  onClick={() => switchTab("library")}
                  onKeyDown={onTabKeyDown}
                >
                  <Library aria-hidden="true" />
                  曲库
                </button>
                <button
                  ref={queueTabRef}
                  type="button"
                  role="tab"
                  className={styles.sourceTab}
                  data-active={tab === "queue" ? "true" : "false"}
                  aria-selected={tab === "queue"}
                  aria-controls={panelId}
                  id={`${panelId}-queue`}
                  onClick={() => switchTab("queue")}
                  onKeyDown={onTabKeyDown}
                >
                  <ListMusic aria-hidden="true" />
                  队列
                </button>
                <button
                  ref={favoritesTabRef}
                  type="button"
                  role="tab"
                  className={styles.sourceTab}
                  data-active={tab === "favorites" ? "true" : "false"}
                  aria-selected={tab === "favorites"}
                  aria-controls={panelId}
                  id={`${panelId}-favorites`}
                  onClick={() => switchTab("favorites")}
                  onKeyDown={onTabKeyDown}
                >
                  <Heart aria-hidden="true" />
                  收藏
                </button>
              </div>
              {tab === "library" ? (
                <button
                  type="button"
                  className={styles.drawerAdd}
                  data-action="add"
                  aria-label={
                    selectedTrack
                      ? `将「${selectedTrack.title}」加入队列`
                      : "将选中曲目加入队列"
                  }
                  {...tip(
                    selectedTrack
                      ? `将「${selectedTrack.title}」加入队列`
                      : "将选中曲目加入队列",
                  )}
                  onClick={addSelectedToQueue}
                >
                  <Plus />
                </button>
              ) : tab === "queue" ? (
                <button
                  type="button"
                  className={styles.drawerAdd}
                  data-active={queueGearActive ? "true" : "false"}
                  aria-label={
                    queueGearActive ? "关闭音乐库队列" : "在音乐库中打开队列"
                  }
                  aria-pressed={queueGearActive}
                  {...tip(
                    queueGearActive ? "关闭音乐库队列" : "在音乐库中打开队列",
                  )}
                  onClick={() => toggleLibraryWindow("queue")}
                >
                  <Settings />
                </button>
              ) : (
                <button
                  type="button"
                  className={styles.drawerAdd}
                  data-active={favoritesGearActive ? "true" : "false"}
                  aria-label={
                    favoritesGearActive
                      ? "关闭音乐库收藏"
                      : "在音乐库中打开我的收藏"
                  }
                  aria-pressed={favoritesGearActive}
                  {...tip(
                    favoritesGearActive
                      ? "关闭音乐库收藏"
                      : "在音乐库中打开我的收藏",
                  )}
                  onClick={() => toggleLibraryWindow("favorites")}
                >
                  <Settings />
                </button>
              )}
              <button
                type="button"
                className={`${styles.drawerAdd} ${styles.locateButton}`}
                aria-label="定位当前播放"
                {...tip("定位当前播放")}
                onClick={locateCurrentInList}
              >
                <Crosshair />
              </button>
            </header>

            {tab === "library" ? (
              <nav className={styles.directoryBar} aria-label="目录位置">
                <button
                  type="button"
                  className={styles.directoryBack}
                  aria-label="返回上级目录"
                  {...tip("返回上级目录")}
                  disabled={!directory.listing?.parent}
                  onClick={directory.goBack}
                >
                  <ArrowLeft aria-hidden="true" />
                </button>
                <div className={styles.directoryPath}>
                  {(
                    directory.listing?.breadcrumbs ?? [
                      { name: "音乐库", path: "" },
                    ]
                  ).map((crumb, index, items) => (
                    <span
                      className={styles.directoryCrumbWrap}
                      key={`${crumb.folderId ?? "root"}:${crumb.path}`}
                    >
                      {index > 0 ? (
                        <ChevronRight
                          className={styles.directorySeparator}
                          aria-hidden="true"
                        />
                      ) : null}
                      <button
                        type="button"
                        className={styles.directoryCrumb}
                        data-current={
                          index === items.length - 1 ? "true" : "false"
                        }
                        disabled={index === items.length - 1}
                        onClick={() => directory.goCrumb(crumb)}
                      >
                        {crumb.name}
                      </button>
                    </span>
                  ))}
                </div>
              </nav>
            ) : null}

            <div
              ref={listRef}
              className={styles.listScroll}
              id={panelId}
              role="tabpanel"
              aria-labelledby={`${panelId}-${tab}`}
              onScroll={loadMoreLibrary}
            >
              {tab === "library" && (directory.loading || directory.error) ? (
                <div className={styles.directoryLoading} aria-live="polite">
                  {directory.loading ? (
                    <>
                      <LoaderCircle
                        className={styles.rowSpinner}
                        aria-hidden="true"
                      />
                      加载目录…
                    </>
                  ) : (
                    directory.error
                  )}
                </div>
              ) : tab === "favorites" &&
                favoritesLoading &&
                favoritesTracks.length === 0 ? (
                <div className={styles.directoryLoading} aria-live="polite">
                  <LoaderCircle
                    className={styles.rowSpinner}
                    aria-hidden="true"
                  />
                  加载收藏…
                </div>
              ) : listEmpty ? (
                <div className={styles.emptyState}>
                  <span className={styles.emptyIcon} aria-hidden="true">
                    {tab === "queue" ? (
                      <ListMusic />
                    ) : tab === "favorites" ? (
                      <Heart />
                    ) : atDirectoryRoot ? (
                      <Upload />
                    ) : (
                      <ArrowLeft />
                    )}
                  </span>
                  <strong>
                    {tab === "queue"
                      ? "队列还是空的"
                      : tab === "favorites"
                        ? "还没有喜欢的曲目"
                        : atDirectoryRoot
                          ? "曲库还空着"
                          : "这个目录没有音频"}
                  </strong>
                  <p>
                    {tab === "queue"
                      ? "在曲库选中曲目，再点右上角按钮加入队列"
                      : tab === "favorites"
                        ? "点亮曲目或当前播放旁的心形，收藏会同步到这里"
                        : atDirectoryRoot
                          ? "点击添加音乐文件夹，由 Media Service 扫描"
                          : "返回上级目录继续浏览"}
                  </p>
                  <button
                    type="button"
                    className={styles.emptyAction}
                    onClick={
                      tab === "queue" || tab === "favorites"
                        ? () => switchTab("library")
                        : atDirectoryRoot
                          ? openFilePicker
                          : directory.goBack
                    }
                  >
                    {tab === "queue" || tab === "favorites" ? (
                      <Library aria-hidden="true" />
                    ) : atDirectoryRoot ? (
                      <Plus aria-hidden="true" />
                    ) : (
                      <ArrowLeft aria-hidden="true" />
                    )}
                    {tab === "queue" || tab === "favorites"
                      ? "去曲库"
                      : atDirectoryRoot
                        ? "添加音乐文件夹"
                        : "返回上级目录"}
                  </button>
                </div>
              ) : (
                <>
                  {tab === "library" ? (
                    <DirectoryList
                      directories={directory.listing?.directories ?? []}
                      onEnter={directory.enterDirectory}
                    />
                  ) : null}
                  <TrackList
                    tracks={visibleTracks}
                    currentId={current?.id ?? null}
                    selectedId={selectedTrack?.id ?? null}
                    playing={playing}
                    favoriteOverrides={favoriteOverrides}
                    onSelect={handleSelectTrack}
                    getCoverUrl={session.getCoverUrl}
                  />
                </>
              )}
              {(tab === "library" && directory.listing?.tracks.hasMore) ||
              (tab === "favorites" && favoritesState.hasMore) ? (
                <div
                  ref={loadMoreSentinelRef}
                  className={styles.listMore}
                  aria-live="polite"
                >
                  {directory.loadingMore || favoritesLoading ? (
                    <>
                      <LoaderCircle
                        className={styles.rowSpinner}
                        aria-hidden="true"
                      />
                      加载中…
                    </>
                  ) : (
                    "继续下滑加载更多"
                  )}
                </div>
              ) : null}
            </div>

            <footer className={styles.drawerFoot}>
              <div className={styles.footNote}>
                <span className={styles.footDot} aria-hidden="true" />
                {tab === "queue"
                  ? `队列 ${queueTracks.length} 首 · ${listTotal}`
                  : tab === "favorites"
                    ? `收藏 ${favoritesState.total || favoritesTracks.length} 首 · ${listTotal}`
                    : atDirectoryRoot
                      ? `目录 ${directoryCount} 个`
                      : `目录 ${allTracks.length}/${libraryTotal} 首 · ${listTotal}`}
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
          <strong>请使用「添加音乐文件夹」</strong>
          <p>本地曲库由 Media Service 扫描，不直接读取拖入的文件</p>
        </div>
      ) : null}

      <p className={styles.srOnly} aria-live="polite">
        {current
          ? `${current.title}，${current.artist}，${playing ? "正在播放" : "已暂停"}`
          : "未选择音频"}
      </p>

      {/* 按钮悬停标签统一浮在按钮上方居中，避免系统 tooltip 压在指针上。 */}
      <TipHost />
    </div>
  );
}
