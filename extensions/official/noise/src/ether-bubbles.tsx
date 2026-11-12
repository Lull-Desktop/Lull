/**
 * EtherBubbles（白噪音）：悬浮式环境声混音器，音轨行如实反映后端 Session 配置。
 *
 * 交互：点击泡泡开关声音，滚轮 / 上下拖动调节音量；点击主泡静音，滚轮调总音量。
 * 齿轮不再展开窗内二级菜单，而是把设置窗口唤起到「音境」页签——睡眠定时、预设、
 * 音轨明细都在那里，窗内只留混音本体。
 * 视觉：玻璃泡 + 发光液体 + 体积环；声场运行时由分析器驱动液体涟漪与呼吸。
 * 页面为工具窗定制的透明外壳：WebView 与 Tauri 窗口都不铺背景，桌面内容可透出。
 */
"use client";

import type { NoiseSession, NoiseTrack } from "@lull/media-sdk";
import {
  ChevronsLeftRight,
  CloudRain,
  Flame,
  Leaf,
  Minus,
  Music2,
  Settings2,
  Sparkles,
  Target,
  Waves,
  X,
  Zap,
} from "lucide-react";
import type {
  ComponentType,
  CSSProperties,
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  WheelEvent as ReactWheelEvent,
  RefObject,
} from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  onWidgetPrefsChanged,
  peekMediaClient,
  readWidgetStorage,
  useWidgetTheme,
  widgetHideWindow,
  widgetIsMinimizable,
  widgetMinimizeWindow,
  widgetOpenSettings,
  widgetRequestResize,
} from "./compat";
import styles from "./ether-bubbles.module.css";
import { useInteractionGuard } from "./interaction-guard";
import {
  buildDemoSession,
  clampLevel,
  INITIAL_MASTER,
  type LibraryMeta,
  masterMood,
  type TrackIconKey,
  type TrackView,
  toTrackView,
  trackMood,
} from "./sound-model";
import { TipHost, tip } from "./tooltip";

const TRACK_ICONS: Record<
  TrackIconKey,
  ComponentType<{ className?: string }>
> = {
  droplet: DropletGlyph,
  zap: Zap,
  leaf: Leaf,
  waves: Waves,
  flame: Flame,
  "cloud-rain": CloudRain,
  target: Target,
  music: Music2,
  sparkles: Sparkles,
};

/** 设置窗口里白噪音页的页签 id（宿主 `SETTINGS_TABS` 之一）。 */
const SETTINGS_NOISE_TAB = "noise";

const NOISE_WIDGET_ID = "noise";
const STARTUP_STORAGE_VERSION = "startup";

type BubbleStyle = CSSProperties & {
  "--tone": string;
  "--fill": string;
  "--master-level": string;
  "--master-angle": string;
  "--master-scale": string;
};

type ReadoutTarget = string | "master";

/**
 * 窗口贴合内容：宽度 = 标签列的自然宽 + 玻璃轨道 + 舞台左右留白，高度 = 根节点高度。
 *
 * 缎带宽度由内容决定（标签列 + 玻璃轨道），所以窗口不再固定 600px：
 * 窗内二级菜单搬走后不会剩下一条透明空带，换成长音轨名时窗口也跟着长。
 * 宽度要量**文案本身的 scrollWidth**而不是缎带的盒宽——标签被列宽夹住时
 * 文字只是打省略号，盒宽不会再变，只看盒宽窗口就永远长不回去。
 * 宽度按停靠侧固定对侧边（`anchor`），视觉上只有另一侧在动；
 * 高度仍走 `window.fit = "content"`，改完尺寸宿主才显示窗口。
 */
function useEtherFit(
  rootRef: RefObject<HTMLElement | null>,
  stageRef: RefObject<HTMLElement | null>,
  ribbonRef: RefObject<HTMLElement | null>,
  side: "left" | "right",
): void {
  useEffect(() => {
    const root = rootRef.current;
    const stage = stageRef.current;
    const ribbon = ribbonRef.current;
    if (!root || !stage || !ribbon) return;
    let frame = 0;
    let lastWidth = 0;
    let lastHeight = 0;

    /** 标签列想要多宽：每行文案的自然宽 + 该行的左右内边距。 */
    const labelWant = (): number => {
      let want = 0;
      for (const label of root.querySelectorAll<HTMLElement>(
        "[data-ether-label]",
      )) {
        const style = getComputedStyle(label);
        const pad =
          (Number.parseFloat(style.paddingLeft) || 0) +
          (Number.parseFloat(style.paddingRight) || 0);
        let text = 0;
        for (const child of label.children) {
          text = Math.max(text, (child as HTMLElement).scrollWidth);
        }
        want = Math.max(want, text + pad);
      }
      return want;
    };

    const measure = (): void => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const style = getComputedStyle(stage);
        const padX =
          (Number.parseFloat(style.paddingLeft) || 0) +
          (Number.parseFloat(style.paddingRight) || 0);
        const railWidth =
          Number.parseFloat(
            getComputedStyle(ribbon).getPropertyValue("--rail-width"),
          ) || 0;
        // +1px 吸收 DPI 换算取整（125% / 150% 缩放会把逻辑宽截到小数），
        // 否则最后那一列会被挤掉 0.2px 从而触发省略号。
        const width = Math.ceil(labelWant() + railWidth + padX) + 1;
        const height = Math.ceil(root.getBoundingClientRect().height);
        // 首帧样式还没生效时量出 0，别把它发给宿主（会被夹成最小宽度）。
        if (width <= 0 || height <= 0) return;
        if (width === lastWidth && height === lastHeight) return;
        lastWidth = width;
        lastHeight = height;
        void widgetRequestResize({ width, height, anchor: side });
      });
    };
    const observer = new ResizeObserver(measure);
    observer.observe(root);
    observer.observe(ribbon);
    measure();
    return () => {
      cancelAnimationFrame(frame);
      observer.disconnect();
    };
  }, [rootRef, stageRef, ribbonRef, side]);
}

/** 参考图里雨滴两侧展开的水翼，用 lucide 基础路径拼一个更轻盈的雨符号。 */
function DropletGlyph({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.15}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden="true"
    >
      <path d="M12 3.4c2.8 3.5 5.9 6.6 5.9 10.1a5.9 5.9 0 0 1-11.8 0C6.1 10 9.2 6.9 12 3.4Z" />
      <path d="M4.2 13.6c1.8.8 3 .5 4.2-.3M19.8 13.6c-1.8.8-3 .5-4.2-.3" />
      <path d="M8.1 17.3c.8.7 1.9 1 3 1" opacity=".65" />
    </svg>
  );
}

function StarGlyph() {
  return (
    <svg
      viewBox="0 0 64 64"
      fill="none"
      stroke="currentColor"
      strokeWidth={0.72}
      strokeLinecap="round"
      aria-hidden="true"
    >
      <circle cx="32" cy="32" r="10.5" opacity=".8" />
      <circle cx="32" cy="32" r="21.5" opacity=".22" />
      <path d="M32 3.5v57M3.5 32h57" opacity=".8" />
      <path d="M11.8 11.8 52.2 52.2M52.2 11.8 11.8 52.2" opacity=".55" />
      <path d="M21 8.5 43 55.5M55.5 21 8.5 43" opacity=".26" />
      <path d="M8.5 21 55.5 43M43 8.5 21 55.5" opacity=".26" />
      <circle cx="32" cy="32" r="2.4" fill="currentColor" stroke="none" />
    </svg>
  );
}

type DragState = {
  pointerId: number;
  startY: number;
  startLevel: number;
  moved: boolean;
};

type BubbleProps = {
  view: TrackView;
  playing: boolean;
  readout: boolean;
  onToggle: (track: NoiseTrack) => void;
  onVolume: (track: NoiseTrack, value: number) => void;
  onAdjust: (target: ReadoutTarget) => void;
};

function SoundBubble({
  view,
  playing,
  readout,
  onToggle,
  onVolume,
  onAdjust,
}: BubbleProps) {
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);
  const track = view.track;
  const level = view.effective;
  const active = playing && level > 0;
  const Icon = TRACK_ICONS[view.icon];
  const errorPrefix = track.error ? "素材缺失 · " : "";
  const status = active
    ? `音量 ${level}%`
    : track.enabled && view.level > 0
      ? "待播放"
      : "已关闭";

  const wheel = (event: ReactWheelEvent<HTMLButtonElement>): void => {
    const step = event.deltaY < 0 ? 4 : -4;
    onVolume(track, level + step);
    onAdjust(track.id);
  };

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startLevel: level,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) return;
    drag.moved = true;
    onVolume(track, drag.startLevel + delta * 0.72);
    onAdjust(track.id);
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const click = (): void => {
    if (suppressClickRef.current) return;
    onToggle(track);
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      onVolume(track, level + 5);
      onAdjust(track.id);
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      onVolume(track, level - 5);
      onAdjust(track.id);
    } else if (event.key === "Home") {
      event.preventDefault();
      onVolume(track, 0);
    } else if (event.key === "End") {
      event.preventDefault();
      onVolume(track, 100);
      onAdjust(track.id);
    }
  };

  return (
    <div
      className={styles.bubbleShell}
      data-active={active ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      data-full={level >= 100 ? "true" : "false"}
      data-readout={readout ? "true" : "false"}
      style={
        {
          "--tone": view.tone,
          "--fill": `${level}%`,
        } as BubbleStyle
      }
    >
      <span className={styles.bubbleAura} aria-hidden="true" />
      <svg
        className={styles.volumeRing}
        viewBox="0 0 100 100"
        aria-hidden="true"
      >
        <circle className={styles.ringTrack} cx="50" cy="50" r="47.4" />
        <circle
          className={styles.ringProgress}
          cx="50"
          cy="50"
          r="47.4"
          pathLength={100}
          strokeDasharray={`${level} 100`}
        />
      </svg>

      <button
        type="button"
        className={styles.bubbleButton}
        data-ether-wheel="true"
        aria-label={`${view.label}，${errorPrefix}${status}。点击${active ? "关闭" : "开启"}，滚轮或上下拖动调节音量`}
        aria-pressed={active}
        onWheel={wheel}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={click}
        onKeyDown={keyDown}
      >
        <span className={styles.sphere}>
          <span className={styles.liquid} aria-hidden="true">
            <span className={styles.liquidSurface} />
            <span className={styles.liquidSurfaceAlt} />
            <span className={styles.liquidShaft} />
            <span className={styles.liquidMotes} />
          </span>
          <span className={styles.sphereShade} aria-hidden="true" />
          <span className={styles.sphereRim} aria-hidden="true" />
          <span className={styles.glyph}>
            <Icon className={styles.glyphSvg} />
          </span>
        </span>
      </button>

      <span className={styles.bubbleReadout} aria-hidden="true">
        {level}%
      </span>
    </div>
  );
}

type MasterBubbleProps = {
  master: number;
  muted: boolean;
  playing: boolean;
  readout: boolean;
  onVolume: (value: number) => void;
  onToggle: () => void;
  onAdjust: () => void;
};

function MasterBubble({
  master,
  muted,
  playing,
  readout,
  onVolume,
  onToggle,
  onAdjust,
}: MasterBubbleProps) {
  const dragRef = useRef<DragState | null>(null);
  const suppressClickRef = useRef(false);
  const [dragging, setDragging] = useState(false);

  const wheel = (event: ReactWheelEvent<HTMLButtonElement>): void => {
    onVolume(master + (event.deltaY < 0 ? 4 : -4));
    onAdjust();
  };

  const pointerDown = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    if (event.button !== 0) return;
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startLevel: master,
      moved: false,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    setDragging(true);
  };

  const pointerMove = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const delta = drag.startY - event.clientY;
    if (!drag.moved && Math.abs(delta) < 4) return;
    drag.moved = true;
    onVolume(drag.startLevel + delta * 0.72);
    onAdjust();
  };

  const endDrag = (event: ReactPointerEvent<HTMLButtonElement>): void => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) return;
    if (drag.moved) {
      suppressClickRef.current = true;
      window.setTimeout(() => {
        suppressClickRef.current = false;
      }, 0);
    }
    dragRef.current = null;
    setDragging(false);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
  };

  const keyDown = (event: ReactKeyboardEvent<HTMLButtonElement>): void => {
    if (event.key === "ArrowUp" || event.key === "ArrowRight") {
      event.preventDefault();
      onVolume(master + 5);
      onAdjust();
    } else if (event.key === "ArrowDown" || event.key === "ArrowLeft") {
      event.preventDefault();
      onVolume(master - 5);
      onAdjust();
    }
  };

  return (
    <div
      className={styles.masterShell}
      data-muted={muted ? "true" : "false"}
      data-playing={playing ? "true" : "false"}
      data-dragging={dragging ? "true" : "false"}
      style={
        {
          "--master-level": `${master}%`,
          "--master-angle": `${master * 3.6}deg`,
          "--master-scale": `${(0.9 + (master / 100) * 0.12).toFixed(3)}`,
          "--tone": "#ffe0a8",
          "--fill": `${master}%`,
        } as BubbleStyle
      }
    >
      <span className={styles.masterAura} aria-hidden="true" />
      <span className={styles.masterRing} aria-hidden="true" />
      <button
        type="button"
        className={styles.masterButton}
        data-ether-wheel="true"
        aria-label={
          !playing
            ? `音境，已暂停，总音量 ${master}%。点击播放`
            : muted
              ? `音境，总音量 ${master}%，已静音。点击恢复声音，滚轮或上下拖动调节总音量`
              : `音境，总音量 ${master}%。点击静音，滚轮或上下拖动调节总音量`
        }
        aria-pressed={playing && muted}
        onWheel={wheel}
        onPointerDown={pointerDown}
        onPointerMove={pointerMove}
        onPointerUp={endDrag}
        onPointerCancel={endDrag}
        onClick={() => {
          if (suppressClickRef.current) return;
          onToggle();
        }}
        onKeyDown={keyDown}
      >
        <span className={styles.motherSphere}>
          <span className={styles.motherDeep} aria-hidden="true" />
          <span className={styles.motherRays} aria-hidden="true" />
          <span className={styles.motherFlare} aria-hidden="true" />
          <span className={styles.motherGlass} aria-hidden="true" />
          <span className={styles.motherGlyph}>
            <StarGlyph />
          </span>
        </span>
      </button>
      <span
        className={styles.masterReadout}
        data-visible={dragging || readout ? "true" : "false"}
      >
        {master}%
      </span>
    </div>
  );
}

export function EtherBubbles() {
  const rootRef = useRef<HTMLDivElement>(null);
  const clientRef = useRef(peekMediaClient());
  const [session, setSession] = useState<NoiseSession>(buildDemoSession);
  const sessionRef = useRef<NoiseSession>(session);
  /** 首个真实快照到达前，不把演示轨的 id 发给后端。 */
  const sessionReadyRef = useRef(false);
  const [awake, setAwake] = useState(false);
  const [libraryMeta, setLibraryMeta] = useState<LibraryMeta | null>(null);
  const [master, setMaster] = useState(INITIAL_MASTER);
  const [muted, setMuted] = useState(false);
  const [dockSide, setDockSide] = useState<"left" | "right">("right");
  const { theme: currentTheme } = useWidgetTheme();
  const [dormant, setDormant] = useState(false);
  const [switching, setSwitching] = useState(false);
  const [readout, setReadout] = useState<ReadoutTarget | null>(null);
  const [canMinimize, setCanMinimize] = useState(false);

  const readoutTimer = useRef<number | null>(null);
  const switchTimer = useRef<number | null>(null);
  const stageRef = useRef<HTMLElement | null>(null);
  const ribbonRef = useRef<HTMLDivElement | null>(null);

  // 窗口宽高都按内容贴合：缎带多宽，窗口就多宽（见 useEtherFit）。
  useEtherFit(rootRef, stageRef, ribbonRef, dockSide);
  // 整个音境模块内禁止框选 / 原生拖拽 / 右键菜单；监听只挂在根节点，
  // 不进 document，因此其他窗口与宿主页面不受影响。
  useInteractionGuard(rootRef);

  // 浏览器预览/单测没有 Media Client，保留纯 UI 的“正在播放”演示态；
  // 放到 effect 里避免 Tauri（有 client）与 SSR（无 window）首屏不一致。
  useEffect(() => {
    if (!clientRef.current) setAwake(true);
  }, []);

  const tracks = [...session.tracks].sort((a, b) => a.order - b.order);
  const anyAudible = tracks.some((track) => track.enabled && track.volume > 0);
  const audible = awake && !muted && anyAudible;

  const commitSession = useCallback((next: NoiseSession): void => {
    sessionRef.current = next;
    setSession(next);
  }, []);

  const applySession = useCallback(
    (next: NoiseSession) => {
      const current = sessionRef.current;
      if (current && next.revision < current.revision) return;
      sessionReadyRef.current = true;
      commitSession(next);
      setMaster(Math.round(next.masterVolume * 100));
      setMuted(next.muted);
      setAwake(next.state === "playing");
    },
    [commitSession],
  );

  useEffect(() => {
    const client = clientRef.current;
    if (!client) return;
    let alive = true;
    let ready = false;
    let snapshotRevision = 0;
    const pending: NoiseSession[] = [];
    const apply = (next: NoiseSession): void => {
      if (alive) applySession(next);
    };
    const stop = client.events.on((event) => {
      if (event.topic === "noise.session.changed") {
        const next = event.payload as NoiseSession;
        if (!ready) {
          pending.push(next);
        } else if (next.revision > snapshotRevision) {
          snapshotRevision = next.revision;
          apply(next);
        }
      } else if (event.topic === "noise.level") {
        const payload = event.payload as { noise: number };
        rootRef.current?.style.setProperty(
          "--ether-pulse",
          payload.noise.toFixed(3),
        );
      }
    });
    void client
      .connect({
        topics: ["noise.session.changed", "noise.level"],
        levels: true,
      })
      .then((snapshot) => {
        if (!alive) return;
        snapshotRevision = snapshot.noiseSession.revision;
        apply(snapshot.noiseSession);
        ready = true;
        for (const state of pending) {
          if (state.revision > snapshotRevision) apply(state);
        }
        pending.length = 0;
      })
      .catch(() => {});
    return () => {
      alive = false;
      stop();
      void client.disconnect();
    };
  }, [applySession]);

  // 启动行为：沿用已保存的偏好。窗内不再有「启动设置」入口（那个二级菜单已移除），
  // 但旧版本存下的「静默启动」继续生效，避免升级后突然出声。
  useEffect(() => {
    try {
      if (
        readWidgetStorage(NOISE_WIDGET_ID, STARTUP_STORAGE_VERSION) === "silent"
      ) {
        setMuted(true);
      }
    } catch {
      // 存储不可用时维持默认「继续上次」。
    }
  }, []);

  // 让 WebView 页面本身也透明：窗口是隐藏创建的，等这里和 useWidgetFit 完成后才显示。
  useEffect(() => {
    const root = document.documentElement;
    root.classList.add("lull-transparent-window");
    return () => root.classList.remove("lull-transparent-window");
  }, []);

  // 滚轮只作用于泡泡，阻止页面在调节音量时滚动。
  useEffect(() => {
    const node = rootRef.current;
    if (!node) return;
    const blockScroll = (event: globalThis.WheelEvent): void => {
      const target = event.target;
      if (target instanceof Element && target.closest("[data-ether-wheel]")) {
        event.preventDefault();
      }
    };
    node.addEventListener("wheel", blockScroll, { passive: false });
    return () => node.removeEventListener("wheel", blockScroll);
  }, []);

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

  // 无操作 5 秒且声场运行时进入「微光」状态；任何指针 / 键盘活动立即唤醒。
  // 窗内不再提供「自动隐去」开关，恒按默认（开）工作。
  useEffect(() => {
    if (!audible) {
      setDormant(false);
      return;
    }
    let timer = 0;
    const arm = (): void => {
      setDormant(false);
      window.clearTimeout(timer);
      timer = window.setTimeout(() => setDormant(true), 5000);
    };
    arm();
    window.addEventListener("pointermove", arm, { passive: true });
    window.addEventListener("pointerdown", arm);
    window.addEventListener("keydown", arm);
    return () => {
      window.clearTimeout(timer);
      window.removeEventListener("pointermove", arm);
      window.removeEventListener("pointerdown", arm);
      window.removeEventListener("keydown", arm);
    };
  }, [audible]);

  useEffect(
    () => () => {
      if (readoutTimer.current) window.clearTimeout(readoutTimer.current);
      if (switchTimer.current) window.clearTimeout(switchTimer.current);
    },
    [],
  );

  const markReadout = useCallback((target: ReadoutTarget): void => {
    setReadout(target);
    if (readoutTimer.current) window.clearTimeout(readoutTimer.current);
    readoutTimer.current = window.setTimeout(() => {
      setReadout(null);
    }, 1600);
  }, []);

  const ensurePlaying = useCallback(
    async (
      client: NonNullable<typeof clientRef.current>,
    ): Promise<NoiseSession> => {
      const current = await client.noise.session.getCurrent();
      if (current.state === "playing") return current;
      return client.noise.session.play();
    },
    [],
  );

  /** 乐观更新本地轨字段；不递增 revision，服务端回包由 applySession 覆盖归一。 */
  const patchLocalTrack = useCallback(
    (trackId: string, patch: Partial<NoiseTrack>): void => {
      commitSession({
        ...sessionRef.current,
        tracks: sessionRef.current.tracks.map((item) =>
          item.id === trackId ? { ...item, ...patch } : item,
        ),
      });
    },
    [commitSession],
  );

  const setTrackVolume = useCallback(
    (track: NoiseTrack, value: number): void => {
      const level = clampLevel(value);
      patchLocalTrack(track.id, { volume: level / 100, enabled: level > 0 });
      setMuted(false);
      markReadout(track.id);
      const client = clientRef.current;
      if (!client || !sessionReadyRef.current) return;
      void (async () => {
        await client.noise.tracks.setVolume(track.id, level / 100);
        await client.noise.tracks.setEnabled(track.id, level > 0);
        const next = await ensurePlaying(client);
        applySession(next);
        applySession(await client.noise.session.setMuted(false));
      })().catch(() => {});
    },
    [applySession, ensurePlaying, markReadout, patchLocalTrack],
  );

  const toggleTrack = useCallback(
    (track: NoiseTrack): void => {
      const playing = sessionRef.current
        ? sessionRef.current.state === "playing"
        : awake;
      const enabled = playing ? !track.enabled : true;
      const currentLevel = clampLevel(track.volume * 100);
      const level = enabled && currentLevel < 5 ? 50 : currentLevel;
      patchLocalTrack(track.id, { enabled, volume: level / 100 });
      setMuted(false);
      markReadout(track.id);
      const client = clientRef.current;
      if (!client || !sessionReadyRef.current) return;
      if (!playing) {
        void (async () => {
          await client.noise.tracks.setVolume(track.id, level / 100);
          await client.noise.tracks.setEnabled(track.id, true);
          applySession(await client.noise.session.play());
          applySession(await client.noise.session.setMuted(false));
        })().catch(() => {});
        return;
      }
      void (async () => {
        await client.noise.tracks.setVolume(track.id, level / 100);
        await client.noise.tracks.setEnabled(track.id, enabled);
        const next = enabled
          ? await ensurePlaying(client)
          : await client.noise.session.getCurrent();
        applySession(next);
        applySession(await client.noise.session.setMuted(false));
      })().catch(() => {});
    },
    [applySession, awake, ensurePlaying, markReadout, patchLocalTrack],
  );

  const setMasterVolume = useCallback(
    (value: number): void => {
      const level = clampLevel(value);
      setMaster(level);
      if (level > 0) setMuted(false);
      markReadout("master");
      const client = clientRef.current;
      if (!client) return;
      void (async () => {
        await client.noise.session.setMasterVolume(level / 100);
        if (level > 0) {
          await client.noise.session.setMuted(false);
          applySession(await ensurePlaying(client));
        } else {
          applySession(await client.noise.session.getCurrent());
        }
      })().catch(() => {});
    },
    [applySession, ensurePlaying, markReadout],
  );

  const toggleMaster = useCallback((): void => {
    const playing = sessionRef.current
      ? sessionRef.current.state === "playing"
      : awake;
    if (!playing) {
      setMuted(false);
      if (master === 0) setMaster(50);
      const client = clientRef.current;
      if (!client) return;
      void (async () => {
        if (master === 0) {
          await client.noise.session.setMasterVolume(0.5);
        }
        await client.noise.session.setMuted(false);
        applySession(await client.noise.session.play());
      })().catch(() => {});
      return;
    }
    const nextMuted = !muted;
    if (!nextMuted && master === 0) setMaster(50);
    setMuted(nextMuted);
    const client = clientRef.current;
    if (!client) return;
    void (async () => {
      if (!nextMuted && master === 0) {
        await client.noise.session.setMasterVolume(0.5);
      }
      await client.noise.session.setMuted(nextMuted);
      const next = !nextMuted
        ? await ensurePlaying(client)
        : await client.noise.session.getCurrent();
      applySession(next);
    })().catch(() => {});
  }, [applySession, awake, ensurePlaying, master, muted]);

  const switchDock = useCallback(
    (side: "left" | "right"): void => {
      if (dockSide === side) return;
      if (switchTimer.current) window.clearTimeout(switchTimer.current);
      setSwitching(true);
      setDockSide(side);
      switchTimer.current = window.setTimeout(() => setSwitching(false), 820);
    },
    [dockSide],
  );

  /**
   * 声场设置：直接把设置窗口唤起到「音境」页签，窗内不再展开二级菜单。
   *
   * `widget_open` 三种情形都由宿主兜住：窗口已在别处 → 事件切页签；
   * 窗口已隐藏/关了 → 先显示再切；还没建过 → 页签暂存，挂载时取走。
   * 所以关掉设置窗之后再点，仍然是同一页签。
   */
  const openSettingsWindow = useCallback((): void => {
    void widgetOpenSettings(SETTINGS_NOISE_TAB);
  }, []);

  /** 素材元数据（分类图标）拉取；失败静默，视觉派生回退纯哈希。 */
  const refreshLibrary = useCallback((): void => {
    const client = clientRef.current;
    if (!client) return;
    void Promise.all([
      client.noise.library.listAssets({ pageSize: 200 }),
      client.noise.library.getCategories(),
    ])
      .then(([page, categories]) => {
        const assetCategory = new Map<string, string>();
        for (const asset of page.items) {
          if (asset.category) assetCategory.set(asset.id, asset.category.id);
        }
        const categoryIcon = new Map<string, string>();
        for (const category of categories) {
          if (category.icon) categoryIcon.set(category.id, category.icon);
        }
        setLibraryMeta({ assetCategory, categoryIcon });
      })
      .catch(() => {});
  }, []);

  useEffect(() => {
    refreshLibrary();
  }, [refreshLibrary]);

  const nextDockSide = dockSide === "right" ? "left" : "right";
  const dockSideLabel =
    nextDockSide === "left" ? "屏幕位置改到左侧" : "屏幕位置改到右侧";

  return (
    <div
      ref={rootRef}
      className={`${styles.root} ether-bubbles-root`}
      data-dormant={dormant ? "true" : "false"}
      data-muted={muted ? "true" : "false"}
      data-playing={awake ? "true" : "false"}
      data-side={dockSide}
      data-switching={switching ? "true" : "false"}
      data-theme={currentTheme.id}
    >
      <main ref={stageRef} className={styles.stage}>
        <div className={styles.ribbonAnchor}>
          <div
            key={dockSide}
            ref={ribbonRef}
            className={styles.ribbonGroup}
            data-switching={switching ? "true" : "false"}
          >
            <div className={styles.dockTop} data-tauri-drag-region="deep">
              <button
                type="button"
                className={styles.dockButton}
                aria-label={dockSideLabel}
                onClick={() => switchDock(nextDockSide)}
                {...tip(dockSideLabel)}
              >
                <ChevronsLeftRight aria-hidden="true" />
              </button>
              <div
                className={styles.dockDragHandle}
                data-tauri-drag-region="deep"
                {...tip("拖动窗口")}
              >
                <span className={styles.dockGrip} aria-hidden="true">
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                  <i />
                </span>
              </div>
              <div className={styles.dockControls}>
                {canMinimize ? (
                  <button
                    type="button"
                    className={styles.dockButton}
                    aria-label="最小化"
                    onClick={() => void widgetMinimizeWindow()}
                    {...tip("最小化")}
                  >
                    <Minus />
                  </button>
                ) : null}
                <button
                  type="button"
                  className={styles.dockButton}
                  aria-label="关闭窗口"
                  onClick={() => void widgetHideWindow()}
                  {...tip("关闭（隐藏到托盘）")}
                >
                  <X />
                </button>
              </div>
            </div>

            <span className={styles.rail} aria-hidden="true">
              <span className={styles.railShine} />
              <span className={styles.railThread} />
            </span>

            <div
              className={`${styles.soundRow} ${styles.masterRow}`}
              data-active="true"
            >
              <div className={styles.rowLabel} data-ether-label="true">
                <span className={styles.glyphTitle}>音境</span>
                <span className={styles.rowMeta}>
                  {awake
                    ? `${master}% · ${masterMood(master, muted)}`
                    : muted
                      ? "静默"
                      : "待播放"}
                </span>
              </div>
              <div className={styles.rowBubble}>
                <MasterBubble
                  master={master}
                  muted={muted}
                  playing={awake}
                  readout={readout === "master"}
                  onVolume={setMasterVolume}
                  onToggle={toggleMaster}
                  onAdjust={() => markReadout("master")}
                />
              </div>
            </div>

            <div className={styles.trackList}>
              {tracks.map((track) => {
                const view = toTrackView(track, libraryMeta);
                return (
                  <div
                    className={styles.soundRow}
                    key={track.id}
                    data-active={awake && view.effective > 0 ? "true" : "false"}
                    data-error={track.error ? "true" : "false"}
                  >
                    <div className={styles.rowLabel} data-ether-label="true">
                      <span className={styles.glyphTitle}>{view.glyph}</span>
                      <span className={styles.rowMeta}>
                        {awake
                          ? `${view.effective}% · ${trackMood(view)}`
                          : track.enabled && view.level > 0
                            ? "待播放"
                            : "静默"}
                      </span>
                    </div>
                    <div className={styles.rowBubble}>
                      <SoundBubble
                        view={view}
                        playing={awake}
                        readout={readout === track.id}
                        onToggle={toggleTrack}
                        onVolume={setTrackVolume}
                        onAdjust={markReadout}
                      />
                    </div>
                  </div>
                );
              })}
            </div>

            {/* 齿轮直接唤起设置窗口的「音境」页签：睡眠定时、预设、音轨明细都在那边，
                窗内不再展开二级菜单，混音本体保持干净。 */}
            <div className={styles.gearRow}>
              <button
                type="button"
                className={styles.gearButton}
                aria-label="声场设置"
                onClick={openSettingsWindow}
                {...tip("打开设置窗口的「音境」页")}
              >
                <Settings2 />
              </button>
            </div>
          </div>
        </div>
      </main>

      <span
        className={styles.switchVeil}
        data-active={switching ? "true" : "false"}
        aria-hidden="true"
      />

      <TipHost />
    </div>
  );
}
