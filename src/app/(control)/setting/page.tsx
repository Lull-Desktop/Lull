// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * 设置窗口页面：偏好（语言 / 主题 / 窗口行为）、壁纸、音乐、白噪音、游戏、扩展、
 * 关于七个页签。壁纸页签承载壁纸层的全部设置（显示模式、场景、每屏配置），音乐
 * 页签除音乐播放器槽位与音乐库开关外，还承载曲库浏览的六个二级分类（全部歌曲 /
 * 我的收藏 / 队列 / 歌单 / 最近添加 / 最近播放）；白噪音页签承载预设下拉（选择并
 * 应用）与当前混音的音轨调节。三个库窗口的开关也各在自己的页签里（壁纸管理
 * 窗口只做媒体素材管理，白噪音库窗口做素材与预设的导入导出）。
 *
 * 媒体订阅由本页独占：音乐页与白噪音页共用一次 `media_connect`（topic 取并集），
 * 面板自己不再 connect/disconnect。
 */
"use client";

import type { LullMediaClient, PlaybackSnapshot } from "@lull/media-sdk";
import { invoke } from "@tauri-apps/api/core";
import { emit, listen } from "@tauri-apps/api/event";
import {
  AppWindow,
  AudioLines,
  Languages,
  MoonStar,
  Music,
  Sparkles,
  Wallpaper,
} from "lucide-react";
import {
  type CSSProperties,
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { ExtensionsPanel } from "@/components/extensions/extensions-panel";
import { SlotPanel } from "@/components/extensions/slot-panel";
import {
  isMusicCategory,
  MusicBrowser,
  type MusicCategory,
} from "@/components/library/music-browser";
import { GamesPanel } from "@/components/settings/games-panel";
import { NoiseSettingsPanel } from "@/components/settings/noise-settings-panel";
import { ThemeModeSwitch } from "@/components/settings/theme-mode-switch";
import { WallpaperPanel } from "@/components/settings/wallpaper-panel";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useExtensionSlots } from "@/hooks/use-extension-slots";
import { useExtensions } from "@/hooks/use-extensions";
import { useFlowTheme } from "@/hooks/use-flow-theme";
import { getMediaClient } from "@/hooks/use-media-client";
import { localizeError } from "@/i18n/errors";
import {
  LOCALE_OPTIONS,
  type LocalePreference,
  localeLabel,
  setLocalePreference,
  syncLocaleFromHost,
  useLocale,
} from "@/i18n/locale";
import { useLocaleReady } from "@/i18n/provider";
import {
  closeExtension,
  type ExtensionInfo,
  openExtension,
  type SlotInfo,
} from "@/lib/extensions";
import { FLOW_THEMES } from "@/lib/flow-theme";
import { SETTINGS_MEDIA_TOPICS } from "@/lib/media-topics";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import {
  BUILTIN_WIDGETS,
  widgetDisplayDescription,
  widgetDisplayName,
} from "@/widgets/registry";
import { version as appVersion } from "../../../../package.json";

/** 与 Rust 侧 `window_prefs::WindowPrefs` 对应。 */
type WindowPrefs = {
  taskbarAndMinimize: boolean;
};

/** 与 Rust 侧 `window_host::WidgetState` 对应。 */
type WidgetState = {
  kind: string;
  visible: boolean;
};

/**
 * 设置页签，顺序即展示顺序：偏好 → 壁纸 → 音乐 → 白噪音 → 游戏 → 扩展 → 关于。
 * 文案在渲染时按当前语言取。
 */
const SETTINGS_TABS = [
  "preferences",
  "wallpaper",
  "music",
  "noise",
  "games",
  "extensions",
  "about",
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABELS: Record<SettingsTab, () => string> = {
  preferences: m.settings_tab_preferences,
  wallpaper: m.settings_tab_wallpaper,
  music: m.settings_tab_music,
  noise: m.settings_tab_noise,
  games: m.settings_tab_games,
  extensions: m.settings_tab_extensions,
  about: m.settings_tab_about,
};

/** 色板玻璃珠的自定义属性。 */
type FlowSwatchStyle = CSSProperties & {
  "--dot-a": string;
  "--dot-b": string;
};

/** 合并卡片内的分区标题：图标 + 标题 + 说明。 */
function SectionHeading({
  icon,
  title,
  description,
}: {
  icon: ReactNode;
  title: string;
  description: string;
}) {
  return (
    <div className="space-y-1.5">
      <h2 className="flex items-center gap-2 text-base font-semibold leading-none tracking-tight">
        {icon}
        {title}
      </h2>
      <p className="text-xs text-muted-foreground">{description}</p>
    </div>
  );
}

/** 三个库窗口页签的 kind，与 `src/widgets/manifests/*.json` 的 id 一致。 */
type LibraryWindowKind = "backdrop" | "library" | "noise-library";

/** 槽位 id，与 `src-tauri/src/extension/slots/defs.rs` 的 SLOTS 一致（v1 只有这两个）。 */
const MUSIC_SLOT_ID = "music-player";
const NOISE_SLOT_ID = "noise-controller";

/** 取库窗口的展示名与描述；语言切换后要跟着变，所以在渲染期取。 */
function libraryWindowInfo(kind: LibraryWindowKind): {
  name: string;
  description: string;
} {
  const widget = BUILTIN_WIDGETS.find((item) => item.id === kind);
  if (!widget) return { name: kind, description: "" };
  return {
    name: widgetDisplayName(widget),
    description: widgetDisplayDescription(widget),
  };
}

/**
 * 库窗口开关行：名称与说明同一行，说明溢出时截断并保留 title。
 * 按钮为按钮模式：文字随窗口显示状态切换（打开/关闭）。
 * 样式、aria 与交互与偏好页原来那一行逐字一致，只是由调用方决定摆在哪。
 */
function LibraryWindowRow({
  kind,
  widgetStates,
  onToggle,
}: {
  kind: LibraryWindowKind;
  widgetStates: Record<string, boolean> | null;
  onToggle: (kind: string, on: boolean) => void;
}) {
  const { name, description } = libraryWindowInfo(kind);
  const open = widgetStates?.[kind] === true;
  return (
    <div className="flex items-center justify-between gap-3 py-1.5">
      <div className="flex min-w-0 items-baseline gap-2">
        <span className="shrink-0 text-sm text-ink-soft">{name}</span>
        {description && (
          <span
            className="truncate text-xs text-muted-foreground"
            title={description}
          >
            {description}
          </span>
        )}
      </div>
      <Button
        type="button"
        variant="default"
        size="sm"
        className={cn(
          "h-7 min-w-14 px-3 text-xs",
          open &&
            "border-bamboo/60 bg-bamboo-mist text-bamboo hover:bg-bamboo-mist/80 hover:text-bamboo",
        )}
        aria-pressed={open}
        aria-label={m.settings_window_toggle_aria({ name })}
        disabled={widgetStates === null}
        onClick={() => onToggle(kind, !open)}
      >
        {open ? m.settings_window_tool_close() : m.settings_window_tool_open()}
      </Button>
    </div>
  );
}

/**
 * 通用页签面板：一张卡片（可选图标 + 标题 + 说明）+ 卡片内的内容块。
 * 根是 absolute + min-h-full（内容矮时铺满窗口可用高度，内容更高时按内容长高，
 * 不会把文字顶出卡片边框）；卡片 flex-1 跟着拉满，窗口缩放时高度自动跟着变。
 * 壁纸 / 音乐 / 白噪音 / 关于用它承载各自内容，偏好页也复用它（不要顶部标题，
 * 三个分区自带 SectionHeading，且未选中时要整块隐藏但仍占位作高度基准）。
 *
 * `fillHeight` 换成 `absolute inset-0`：面板高度锁定为容器高度、不再被内容撑高，
 * 内部用 `min-h-0 flex-1 overflow-y-auto` 形成唯一滚动条（音乐页的曲库列表要这个）。
 */
function LibraryPane({
  icon,
  title,
  description,
  testId,
  cardTestId,
  contentClassName,
  inactive = false,
  collapseWhenInactive = false,
  fillHeight = false,
  children,
}: {
  icon?: ReactNode;
  title?: string;
  description?: string;
  testId: string;
  cardTestId?: string;
  /** 覆盖内容区内边距/间距；默认 p-6。 */
  contentClassName?: string;
  /** 未选中：整块 invisible + aria-hidden + inert，但仍然占位。 */
  inactive?: boolean;
  /**
   * 未选中时用 `display:none` 彻底移出布局，只保留 DOM 与状态。
   * 内容可能比视图长（壁纸页）时必须用它：`invisible` 仍参与布局与溢出计算，
   * 会让停留的其它页签底部多出一段空白可滚动区。
   */
  collapseWhenInactive?: boolean;
  /** 高度锁定为容器高度（内容自己滚），不再随内容长高。 */
  fillHeight?: boolean;
  children?: ReactNode;
}) {
  return (
    <main
      className={cn(
        fillHeight ? "absolute inset-0" : "absolute inset-x-0 top-0 min-h-full",
        inactive && collapseWhenInactive ? "hidden" : "flex flex-col",
        inactive && !collapseWhenInactive && "invisible",
      )}
      aria-hidden={inactive ? true : undefined}
      inert={inactive ? true : undefined}
      data-testid={testId}
    >
      <Card
        // fillHeight 时卡片要能被压到容器高度以下：flex 项的自动最小尺寸是
        // min-content，不加 min-h-0 的话极矮窗口会把卡片撑出面板。
        className={cn("flex w-full flex-1 flex-col", fillHeight && "min-h-0")}
        data-testid={cardTestId}
      >
        <CardContent
          className={cn(
            "flex flex-1 flex-col",
            // 高度锁定时内容区自己滚：窗口被压到极矮（min 640×320）时，
            // 标题 / 槽位 / 开关这些固定块放不下也不会溢出卡片。
            fillHeight && "min-h-0 overflow-y-auto",
            contentClassName ?? "p-6",
          )}
        >
          {title !== undefined && (
            <SectionHeading
              icon={icon ?? null}
              title={title}
              description={description ?? m.settings_tab_placeholder()}
            />
          )}
          {children}
        </CardContent>
      </Card>
    </main>
  );
}

/** 组件管理块：标题 + 单槽位面板 + 错误提示。原样从偏好页搬来，只多了 slotId 过滤。 */
function SlotSection({
  slotId,
  slots,
  error,
  onChanged,
  onMessage,
}: {
  slotId: string;
  slots: SlotInfo[] | null;
  error: string;
  onChanged: () => Promise<void>;
  onMessage: (message: string, tone?: "info" | "error") => void;
}) {
  return (
    <div
      className="space-y-2 border-t border-border/50 pt-2"
      data-testid="settings-feature-slots"
    >
      <SlotPanel
        slots={slots ? slots.filter((slot) => slot.id === slotId) : null}
        busy={false}
        onChanged={onChanged}
        onMessage={onMessage}
        showHeading={true}
      />
      {error && <p className="text-xs text-destructive">{error}</p>}
    </div>
  );
}

export default function Settings() {
  const windowPrefsSwitchId = useId();
  // 订阅语言：页签与卡片文案在语言切换后要重渲染。
  useLocale();
  const localeReady = useLocaleReady();
  const { themeId: flowThemeId, theme: flowTheme, setTheme } = useFlowTheme();
  const [windowPrefs, setWindowPrefs] = useState<WindowPrefs | null>(null);
  const [windowPrefsMsg, setWindowPrefsMsg] = useState("");
  const [widgetStates, setWidgetStates] = useState<Record<
    string,
    boolean
  > | null>(null);
  const [widgetMsg, setWidgetMsg] = useState("");
  const [slotError, setSlotError] = useState("");
  const [tab, setTab] = useState<SettingsTab>("preferences");
  // 壁纸面板挂载即拉显示器与场景配置，条件渲染会让每次切回都重发请求并闪一次
  // 「查询中」。首次进入后常驻（切走用 display:none 隐藏），保留 DOM 与订阅。
  const [wallpaperVisited, setWallpaperVisited] = useState(false);
  // 音乐面板同理：挂载即连媒体客户端并拉列表，切回来不该重连重拉。
  const [musicVisited, setMusicVisited] = useState(false);
  // 白噪音面板首次访问后常驻：预设下拉与音轨列表不该每次切回来都重拉。
  const [noiseVisited, setNoiseVisited] = useState(false);
  // 媒体连接由本页独占：Rust 的 media_connect 按窗口 label 只保存一份订阅，
  // 面板各自 connect 会互相踢掉，所以音乐页与白噪音页共用这一份。
  const [mediaEnabled, setMediaEnabled] = useState(false);
  const [mediaClient, setMediaClient] = useState<LullMediaClient | null>(null);
  const [mediaSnapshot, setMediaSnapshot] = useState<PlaybackSnapshot | null>(
    null,
  );
  const [mediaMsg, setMediaMsg] = useState("");
  // 曲库二级分类：设置页持有，外部（播放器齿轮）唤起时可指定。
  const [musicCategory, setMusicCategory] = useState<MusicCategory>("tracks");
  const { items: extensions, refresh: refreshExtensions } = useExtensions();
  const { slots, refresh: refreshSlots } = useExtensionSlots();
  // 官方包已迁为 Slot Provider；这里只保留“官方非 Provider”兼容项。
  const officialTools = (extensions ?? []).filter(
    (item) =>
      item.origin === "bundled" &&
      item.kind === "widget" &&
      item.enabled &&
      (item.provides?.length ?? 0) === 0,
  );
  /** null = 还没读到偏好（首帧），此时不高亮任何一项，避免选错又跳回去。 */
  const [languagePref, setLanguagePref] = useState<LocalePreference | null>(
    null,
  );
  const [languageMsg, setLanguageMsg] = useState("");

  // 语言偏好以 Rust 的 preferences.json 为准：注入的语言只说明「生效值」，
  // 是「跟随系统」还是手动选的语言，得问一次后端。
  useEffect(() => {
    let alive = true;
    void syncLocaleFromHost().then((state) => {
      if (!alive || !state) return;
      setLanguagePref(state.explicit ? state.locale : "system");
    });
    return () => {
      alive = false;
    };
  }, []);

  const changeLanguage = useCallback(
    (next: LocalePreference): void => {
      setLanguageMsg("");
      const previous = languagePref;
      // 先乐观选中，失败回滚并提示（后端的值才是最终态）。
      setLanguagePref(next);
      void setLocalePreference(next)
        .then((state) => {
          setLanguagePref(state.explicit ? state.locale : "system");
        })
        .catch((error: unknown) => {
          setLanguageMsg(
            m.settings_language_save_failed({ reason: localizeError(error) }),
          );
          setLanguagePref(previous);
        });
    },
    [languagePref],
  );

  // 媒体连接：进入音乐 / 白噪音页签时建立一次，卸载或连接失败时断开。
  useEffect(() => {
    if (!mediaEnabled) return;
    const media = getMediaClient();
    if (!media) return;
    setMediaClient(media);
    let alive = true;
    void media
      .connect({ topics: [...SETTINGS_MEDIA_TOPICS] })
      .then((next) => {
        if (!alive) return;
        setMediaSnapshot(next);
        setMediaMsg("");
      })
      .catch((reason: unknown) => {
        if (!alive) return;
        setMediaMsg(
          m.settings_media_connect_failed({ reason: localizeError(reason) }),
        );
        // 落回未启用状态，下次切回音乐 / 白噪音页时重试。
        setMediaEnabled(false);
      });
    return () => {
      alive = false;
      setMediaClient(null);
      void media.disconnect();
    };
  }, [mediaEnabled]);

  // 全局窗口偏好：所有窗口的任务栏 / 最小化开关，写入后 Rust 广播给各窗口顶栏。
  useEffect(() => {
    invoke<WindowPrefs>("window_prefs_get")
      .then((prefs) => {
        setWindowPrefs(prefs);
      })
      .catch(() => {
        setWindowPrefs(null);
      });
  }, []);

  const updateWindowPrefs = useCallback((on: boolean): void => {
    setWindowPrefsMsg("");
    // 先乐观更新开关，失败时用后端值回滚。
    setWindowPrefs({ taskbarAndMinimize: on });
    invoke<WindowPrefs>("window_prefs_set", { taskbarAndMinimize: on })
      .then((prefs) => {
        setWindowPrefs(prefs);
      })
      .catch((err: unknown) => {
        setWindowPrefsMsg(
          m.settings_save_failed({ reason: localizeError(err) }),
        );
        void invoke<WindowPrefs>("window_prefs_get")
          .then((prefs) => {
            setWindowPrefs(prefs);
          })
          .catch(() => {});
      });
  }, []);

  // 工具窗开关：读取各窗口当前的显示状态，并在任一窗口显示/隐藏后刷新。
  const refreshWidgets = useCallback((): void => {
    invoke<WidgetState[]>("widget_states")
      .then((states) => {
        const next: Record<string, boolean> = {};
        for (const state of states) next[state.kind] = state.visible;
        setWidgetStates(next);
      })
      .catch(() => {
        setWidgetStates(null);
      });
  }, []);

  useEffect(() => {
    refreshWidgets();
    const unlisten = listen("widgets-changed", () => {
      refreshWidgets();
    }).catch(() => () => {});
    return () => {
      unlisten.then((stop) => stop()).catch(() => {});
    };
  }, [refreshWidgets]);

  const toggleWidget = useCallback(
    (kind: string, on: boolean): void => {
      setWidgetMsg("");
      // 开关先乐观更新；真实状态由 widgets-changed 事件刷新。
      setWidgetStates((prev) => (prev ? { ...prev, [kind]: on } : prev));
      invoke(on ? "widget_open" : "widget_close", { kind }).catch(
        (err: unknown) => {
          setWidgetMsg(
            m.settings_action_failed({ reason: localizeError(err) }),
          );
          refreshWidgets();
        },
      );
    },
    [refreshWidgets],
  );

  // SlotPanel 的变更同时刷新扩展列表与槽位：扩展页的 Provider 徽章要跟着更新。
  const refreshSlotViews = useCallback(async (): Promise<void> => {
    await Promise.all([refreshExtensions(), refreshSlots()]);
  }, [refreshExtensions, refreshSlots]);

  // 成功状态已由 Slot 徽章反映，这里只保留失败原因，避免堆叠“打开/运行中”提示。
  const handleSlotMessage = useCallback(
    (message: string, tone?: "info" | "error"): void => {
      setSlotError(tone === "error" ? message : "");
    },
    [],
  );

  // 槽位面板按页签各挂一个，切页签时清掉上一次的错误，避免提示串到别的页签。
  const selectTab = useCallback((value: SettingsTab): void => {
    setSlotError("");
    if (value === "wallpaper") setWallpaperVisited(true);
    if (value === "music") setMusicVisited(true);
    if (value === "noise") setNoiseVisited(true);
    if (value === "music" || value === "noise") setMediaEnabled(true);
    setTab(value);
  }, []);

  // 扩展页 Scene 的「素材管理」切到壁纸页签，不再另开壁纸管理窗口。
  const openWallpaperTab = useCallback((): void => {
    setWidgetMsg("");
    selectTab("wallpaper");
  }, [selectTab]);

  /** 外部指定页签："music" 只切页签，"music:queue" 再定位到对应分类。 */
  const applyOpenTab = useCallback(
    (raw: string | null | undefined): void => {
      if (!raw) return;
      const [nextTab, nextCategory] = raw.split(":");
      if (!(SETTINGS_TABS as readonly string[]).includes(nextTab)) return;
      if (nextCategory && isMusicCategory(nextCategory)) {
        setMusicCategory(nextCategory);
      }
      selectTab(nextTab as SettingsTab);
    },
    [selectTab],
  );

  // 播放器扩展等外部入口经 widget_open 指定页签：挂载时取走 Rust 暂存值
  // （新建窗口时事件早于监听注册），运行中收 widget-open-tab 事件。
  useEffect(() => {
    let disposed = false;
    void invoke<string | null>("widget_take_open_tab", { kind: "settings" })
      .then((value) => {
        if (!disposed) applyOpenTab(value);
      })
      .catch(() => {
        // 浏览器预览 / 单测没有 Tauri IPC；页签保持默认。
      });
    let stop: (() => void) | null = null;
    void listen<{ tab?: string }>("widget-open-tab", (event) => {
      applyOpenTab(event.payload?.tab ?? null);
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {
        // 同上；事件不可用时只影响外部指定页签。
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [applyOpenTab]);

  // 页签 / 曲库分类变化广播给宿主壳：播放器的齿轮据此点亮与判断「再点一次」。
  useEffect(() => {
    void emit("settings-music-changed", {
      tab,
      category: tab === "music" ? musicCategory : null,
    }).catch(() => {
      // 浏览器预览 / 单测没有 Tauri 事件系统。
    });
  }, [tab, musicCategory]);

  const toggleOfficialTool = useCallback(
    (item: ExtensionInfo, on: boolean): void => {
      setWidgetMsg("");
      const action = on
        ? openExtension("widget", item.id)
        : closeExtension(item.id);
      void action
        .then(() => refreshExtensions())
        .catch((error: unknown) => {
          setWidgetMsg(
            m.settings_action_failed({
              reason: localizeError(error),
            }),
          );
          void refreshExtensions();
        });
    },
    [refreshExtensions],
  );

  // 静态导出的预渲染 HTML 是基准语言，客户端首帧已是注入语言；
  // 挂载前不渲染文案，避免水合不匹配与错误语言闪烁。
  if (!localeReady) {
    return <div className="mx-auto w-full max-w-4xl px-4 py-4" />;
  }

  return (
    // 页面根撑满窗口可用高度（外壳是 fit=false 的 h-full 容器），
    // 下面内容区才能用 flex-1 把剩余高度交给面板。
    <div className="mx-auto flex min-h-full w-full max-w-4xl flex-col px-4 py-3">
      {/* 页签固定每行 4 个，多出的自动落到第二行；列宽由网格统一，
          所以两行标签上下对齐、间距一致，且不随窗口宽度改变排布。
          字号 text-sm（14px），纵向 py-1 + leading-5 让放大的字不显拥挤。 */}
      <div
        className="sticky top-0 z-10 mb-2 grid grid-cols-4 gap-0.5 rounded-xl border border-border/60 bg-paper-warm/95 p-0.5 text-sm shadow-sm backdrop-blur"
        role="tablist"
        aria-label={m.settings_tabs_label()}
      >
        {SETTINGS_TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => selectTab(value)}
            className={`min-w-0 truncate rounded-lg px-2 py-1 leading-5 text-center transition-colors ${
              tab === value
                ? "bg-paper text-ink shadow-sm"
                : "text-muted-foreground hover:text-ink-soft"
            }`}
          >
            {TAB_LABELS[value]()}
          </button>
        ))}
      </div>

      {widgetMsg && (
        <p className="mb-2 text-xs text-destructive" role="alert">
          {widgetMsg}
        </p>
      )}

      {mediaMsg && (
        <p className="mb-2 text-xs text-destructive" role="alert">
          {mediaMsg}
        </p>
      )}

      {tab !== "about" && (
        // 六个面板都绝对定位铺在同一个定位容器里（容器自己 flex-1 撑满剩余高度）：
        // 内容矮时面板靠 min-h-full 拉满窗口，内容更高时按内容长高、页面照常滚动。
        // 偏好面板常驻挂载，切走时只 invisible 并 aria-hidden/inert，保持 DOM 与状态。
        <div className="relative flex-1">
          <LibraryPane
            testId="settings-preferences-pane"
            cardTestId="settings-preferences-card"
            contentClassName="space-y-5 p-5"
            inactive={tab !== "preferences"}
          >
            {/* Language（界面语言，偏好以 Rust 的 preferences.json 为准） */}
            <section
              className="space-y-2"
              data-testid="settings-language-section"
            >
              <SectionHeading
                icon={<Languages className="h-4 w-4 text-bamboo" />}
                title={m.settings_language_title()}
                description={m.settings_language_description()}
              />
              <div
                role="radiogroup"
                aria-label={m.settings_language_title()}
                className="flex flex-wrap gap-2"
              >
                {/* biome-ignore lint/a11y/useSemanticElements: language pills intentionally use ARIA radio semantics with custom styling */}
                <button
                  type="button"
                  role="radio"
                  aria-checked={languagePref === "system"}
                  onClick={() => changeLanguage("system")}
                  className={cn(
                    "rounded-full border px-3 py-1.5 text-xs transition",
                    languagePref === "system"
                      ? "border-bamboo/60 bg-bamboo-mist text-bamboo shadow-sm"
                      : "border-border/70 text-muted-foreground hover:border-bamboo/40 hover:text-ink-soft",
                  )}
                >
                  {m.settings_language_follow_system()}
                </button>
                {LOCALE_OPTIONS.map((option) => (
                  // biome-ignore lint/a11y/useSemanticElements: language pills intentionally use ARIA radio semantics with custom styling
                  <button
                    key={option}
                    type="button"
                    role="radio"
                    aria-checked={languagePref === option}
                    onClick={() => changeLanguage(option)}
                    className={cn(
                      "rounded-full border px-3 py-1.5 text-xs transition",
                      languagePref === option
                        ? "border-bamboo/60 bg-bamboo-mist text-bamboo shadow-sm"
                        : "border-border/70 text-muted-foreground hover:border-bamboo/40 hover:text-ink-soft",
                    )}
                  >
                    {localeLabel(option)}
                  </button>
                ))}
              </div>
              {languageMsg && (
                <p className="text-xs text-destructive">{languageMsg}</p>
              )}
            </section>

            {/* Flow Theme（从白噪音迁移过来的全局主题流光） */}
            <section
              className="space-y-3 border-t border-border/60 pt-5"
              data-testid="settings-theme-section"
            >
              <SectionHeading
                icon={<Sparkles className="h-4 w-4 text-bamboo" />}
                title={m.settings_theme_title()}
                description={m.settings_theme_description()}
              />
              <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2.5 border-0 p-0">
                <legend className="sr-only">{m.settings_theme_title()}</legend>
                {FLOW_THEMES.map((theme) => {
                  const active = theme.id === flowThemeId;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      aria-label={m.settings_theme_pick_aria({
                        name: theme.label(),
                      })}
                      aria-pressed={active}
                      onClick={() => setTheme(theme.id)}
                      className={cn(
                        "flex items-center gap-2 rounded-full border px-2 py-1 text-xs transition",
                        active
                          ? "border-bamboo/60 bg-bamboo-mist text-bamboo shadow-sm"
                          : "border-border/70 text-muted-foreground hover:border-bamboo/40 hover:text-ink-soft",
                      )}
                    >
                      <span className="grid h-4 w-4 shrink-0 place-items-center">
                        <span
                          className="flow-theme-swatch h-4 w-4"
                          style={
                            {
                              "--dot-a": theme.a,
                              "--dot-b": theme.b,
                            } as FlowSwatchStyle
                          }
                        />
                      </span>
                      {theme.label()}
                    </button>
                  );
                })}
              </fieldset>

              {/* 黑白样式：同一分区里切换浅色纸面 / 深色墨面 */}
              <div className="border-t border-border/50 pt-2">
                <ThemeModeSwitch />
              </div>

              <div
                className="overflow-hidden rounded-lg border border-paper-deep/60 bg-paper-warm/40 p-2.5"
                style={{
                  backgroundImage: `radial-gradient(ellipse 70% 100% at 100% 0%, ${flowTheme.b}24, transparent 70%), radial-gradient(ellipse 60% 100% at 0% 100%, ${flowTheme.a}1f, transparent 72%)`,
                }}
              >
                <div className="flex flex-wrap items-center justify-between gap-2">
                  <span className="text-sm text-ink-soft">
                    {m.settings_theme_current_prefix()}
                    <strong className="font-medium">{flowTheme.label()}</strong>
                  </span>
                  <span className="font-mono text-[10px] tracking-wide text-ink-faint">
                    {flowTheme.a} · {flowTheme.b}
                  </span>
                </div>
                <div
                  className="mt-2.5 h-1.5 rounded-full"
                  style={{
                    backgroundImage: `linear-gradient(90deg, ${flowTheme.a}, ${flowTheme.b}, ${flowTheme.c})`,
                  }}
                />
                <div className="mt-2 flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-bamboo px-2.5 py-1 text-[10px] text-cloud">
                    {m.settings_theme_primary()}
                  </span>
                  <span className="rounded-full border border-bamboo/40 bg-bamboo-mist px-2.5 py-1 text-[10px] text-bamboo">
                    {m.settings_theme_accent()}
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    {m.settings_theme_applies_globally()}
                  </span>
                </div>
              </div>
            </section>

            {/* Window Behavior（全局窗口偏好） */}
            <section
              className="space-y-2 border-t border-border/60 pt-3"
              data-testid="settings-window-section"
            >
              <SectionHeading
                icon={<AppWindow className="h-4 w-4 text-bamboo" />}
                title={m.settings_window_title()}
                description={m.settings_window_description()}
              />
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-0.5">
                  <Label
                    htmlFor={windowPrefsSwitchId}
                    className="text-ink-soft"
                  >
                    {m.settings_window_taskbar()}
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    {m.settings_window_taskbar_hint()}
                  </p>
                </div>
                <Switch
                  id={windowPrefsSwitchId}
                  checked={windowPrefs?.taskbarAndMinimize === true}
                  disabled={windowPrefs === null}
                  onCheckedChange={updateWindowPrefs}
                />
              </div>

              {/* 库窗口开关已迁到壁纸 / 音乐 / 白噪音页签；这里只留官方非 Provider
                  工具窗，没有实例时不渲染容器，避免留下一条空的上边框。 */}
              {officialTools.length > 0 && (
                <div className="divide-y divide-border/40 border-t border-border/50">
                  {officialTools.map((item) => (
                    <div
                      key={`official-${item.id}`}
                      className="flex items-center justify-between gap-3 py-1.5"
                    >
                      <div className="flex min-w-0 items-baseline gap-2">
                        <span className="shrink-0 text-sm text-ink-soft">
                          {item.name}
                          <span className="ml-1.5 text-[10px] text-ink-faint">
                            {m.ext_origin_official()}
                          </span>
                        </span>
                        {item.description && (
                          <span
                            className="truncate text-xs text-muted-foreground"
                            title={item.description}
                          >
                            {item.description}
                          </span>
                        )}
                      </div>
                      <Switch
                        aria-label={m.settings_window_toggle_aria({
                          name: item.name,
                        })}
                        checked={Boolean(item.running && item.visible)}
                        onCheckedChange={(on) => toggleOfficialTool(item, on)}
                      />
                    </div>
                  ))}
                </div>
              )}

              {windowPrefsMsg && (
                <p className="text-xs text-destructive">{windowPrefsMsg}</p>
              )}
            </section>

            {/* ── Button Showcase ── */}
            {/* <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Palette className="h-5 w-5 text-bamboo" />
                Button 变体
              </CardTitle>
              <CardDescription>
                shadcn 标准变体 + 新增 bamboo / bambooGhost / paper 风格
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-3">
              <Button>Default</Button>
              <Button variant="secondary">Secondary</Button>
              <Button variant="outline">Outline</Button>
              <Button variant="ghost">Ghost</Button>
              <Button variant="bamboo">Bamboo</Button>
              <Button variant="bambooGhost">Bamboo Ghost</Button>
              <Button variant="paper">Paper</Button>
            </CardContent>
          </Card> */}

            {/* ── Floral Controls ── */}
            {/* <div className="grid gap-6 md:grid-cols-2">
            <Card className="w-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Sparkles className="h-4 w-4 text-bamboo" />
                  开关 &amp; 滑块
                </CardTitle>
                <CardDescription>Switch + Slider 组件</CardDescription>
              </CardHeader>
              <CardContent className="space-y-6">
                <div className="flex items-center justify-between">
                  <Label htmlFor={notificationId} className="text-ink-soft">
                    通知
                  </Label>
                  <Switch
                    id={notificationId}
                    checked={notifications}
                    onCheckedChange={setNotifications}
                  />
                </div>
                <div className="space-y-3">
                  <Label className="text-ink-soft">字号</Label>
                  <div className="flex items-center gap-4">
                    <Slider
                      value={fontSize}
                      onValueChange={setFontSize}
                      min={12}
                      max={24}
                      step={1}
                      className="flex-1"
                    />
                    <span className="w-8 text-right text-xs font-mono tabular-nums text-muted-foreground">
                      {fontSize[0]}px
                    </span>
                  </div>
                </div>
              </CardContent>
            </Card>

            <Card className="w-full">
              <CardHeader>
                <CardTitle className="flex items-center gap-2 text-base">
                  <Rocket className="h-4 w-4 text-bamboo" />
                  分段控件
                </CardTitle>
                <CardDescription>
                  ToggleGroup 替代 SlidingButtonGroup
                </CardDescription>
              </CardHeader>
              <CardContent className="space-y-4">
                <Label className="text-ink-soft">视图模式</Label>
                <ToggleGroup
                  type="single"
                  value={viewMode}
                  onValueChange={(v) => v && setViewMode(v)}
                  variant="outline"
                  className="w-full"
                >
                  <ToggleGroupItem value="edit" className="flex-1">
                    编辑
                  </ToggleGroupItem>
                  <ToggleGroupItem value="split" className="flex-1">
                    分栏
                  </ToggleGroupItem>
                  <ToggleGroupItem value="preview" className="flex-1">
                    预览
                  </ToggleGroupItem>
                </ToggleGroup>
                <div className="flex gap-2">
                  <ToggleGroup type="single" variant="outline" size="sm">
                    <ToggleGroupItem value="light">浅色</ToggleGroupItem>
                    <ToggleGroupItem value="dark">深色</ToggleGroupItem>
                  </ToggleGroup>
                  <span className="text-xs text-muted-foreground self-center">
                    主题切换（同右上角）
                  </span>
                </div>
              </CardContent>
            </Card>
          </div> */}

            {/* ── Tauri Integration ── */}
            {/* <Card className="w-full">
            <CardHeader>
              <div className="flex items-center gap-2">
                <Zap className="h-5 w-5 text-bamboo" />
                <CardTitle>Tauri 集成</CardTitle>
              </div>
              <CardDescription>调用 Rust 后端函数</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                <Button onClick={greet} variant="bamboo">
                  <Zap className="mr-2 h-4 w-4" />
                  Call &quot;greet&quot; from Rust
                </Button>
                <p className="text-sm text-muted-foreground break-words">
                  {greeted ?? "点击按钮调用 Rust 函数"}
                </p>
              </div>
            </CardContent>
            <CardFooter className="text-xs text-muted-foreground border-t border-border/50 pt-4">
              修改 src-tauri/src/lib.rs 自定义问候信息
            </CardFooter>
          </Card> */}

            {/* ── Noise Texture Demo ── */}
            {/* <Card className="w-full noise-bg overflow-hidden">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Feather className="h-5 w-5 text-bamboo" />
                纸张质感
              </CardTitle>
              <CardDescription>.noise-bg 噪声纹理 + 暖纸色背景</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid gap-4 md:grid-cols-3">
                <div className="h-24 rounded-xl bg-paper border border-paper-deep/50 flex items-center justify-center text-xs text-ink-faint">
                  bg-paper
                </div>
                <div className="h-24 rounded-xl bg-paper-warm border border-paper-deep/50 flex items-center justify-center text-xs text-ink-faint">
                  bg-paper-warm
                </div>
                <div className="h-24 rounded-xl bg-paper-deep border border-paper-deep/50 flex items-center justify-center text-xs text-ink-faint">
                  bg-paper-deep
                </div>
                <div className="h-24 rounded-xl bg-bamboo flex items-center justify-center text-xs text-cloud">
                  bg-bamboo
                </div>
                <div className="h-24 rounded-xl bg-bamboo-mist flex items-center justify-center text-xs text-bamboo">
                  bg-bamboo-mist
                </div>
                <div className="h-24 rounded-xl bg-ink flex items-center justify-center text-xs text-[#e5e1da]">
                  bg-ink
                </div>
              </div>
            </CardContent>
          </Card> */}
          </LibraryPane>
          {wallpaperVisited && (
            <LibraryPane
              icon={<Wallpaper className="h-4 w-4 text-bamboo" />}
              title={TAB_LABELS.wallpaper()}
              description={m.wallpaper_description()}
              testId="settings-wallpaper-pane"
              cardTestId="settings-wallpaper-card"
              // 长属性排在简写之后：CardContent 自带的 p-6 会盖掉 p-5。
              contentClassName="space-y-4 px-5 pt-5 pb-5"
              inactive={tab !== "wallpaper"}
              collapseWhenInactive
            >
              <div className="border-t border-border/60 pt-4">
                <LibraryWindowRow
                  kind="backdrop"
                  widgetStates={widgetStates}
                  onToggle={toggleWidget}
                />
              </div>
              <WallpaperPanel />
            </LibraryPane>
          )}
          {musicVisited && (
            <LibraryPane
              icon={<Music className="h-4 w-4 text-bamboo" />}
              title={TAB_LABELS.music()}
              description={m.settings_music_description()}
              testId="settings-music-pane"
              cardTestId="settings-music-card"
              // 长属性排在简写之后：CardContent 自带的 p-6 会盖掉 p-5。
              contentClassName="min-h-0 gap-3 px-5 pt-5 pb-5"
              fillHeight
              inactive={tab !== "music"}
              collapseWhenInactive
            >
              <SlotSection
                slotId={MUSIC_SLOT_ID}
                slots={slots}
                error={slotError}
                onChanged={refreshSlotViews}
                onMessage={handleSlotMessage}
              />
              <LibraryWindowRow
                kind="library"
                widgetStates={widgetStates}
                onToggle={toggleWidget}
              />
              {/* 曲库二级分类 + 内容区：整块占满剩余高度，内容自己滚。 */}
              <MusicBrowser
                client={mediaClient}
                initialPlayer={mediaSnapshot?.player ?? null}
                category={musicCategory}
                onCategoryChange={setMusicCategory}
              />
            </LibraryPane>
          )}
          {noiseVisited && (
            <LibraryPane
              icon={<AudioLines className="h-4 w-4 text-bamboo" />}
              title={TAB_LABELS.noise()}
              description={m.settings_noise_description()}
              testId="settings-noise-pane"
              cardTestId="settings-noise-card"
              // 长属性排在简写之后：CardContent 自带的 p-6 会盖掉 p-5。
              contentClassName="min-h-0 gap-3 px-5 pt-5 pb-5"
              fillHeight
              inactive={tab !== "noise"}
              collapseWhenInactive
            >
              <SlotSection
                slotId={NOISE_SLOT_ID}
                slots={slots}
                error={slotError}
                onChanged={refreshSlotViews}
                onMessage={handleSlotMessage}
              />
              <LibraryWindowRow
                kind="noise-library"
                widgetStates={widgetStates}
                onToggle={toggleWidget}
              />
              {/* 预设选择与当前混音：使用侧，保存/导入导出都在白噪音库窗口。 */}
              <NoiseSettingsPanel client={mediaClient} />
            </LibraryPane>
          )}
          {/* 开发版本未开放*/}
          {tab === "games" && (
            <main
              className="absolute inset-0"
              data-testid="settings-games-pane"
            >
              <GamesPanel />
            </main>
          )}
          {tab === "extensions" && (
            <main
              className="absolute inset-0"
              data-testid="settings-extensions-pane"
            >
              <ExtensionsPanel onOpenWallpaperSettings={openWallpaperTab} />
            </main>
          )}
        </div>
      )}
      {tab === "about" && (
        // 关于页与其它页签同一套面板：面板绝对定位，需要一个撑高的定位容器。
        <div className="relative flex-1">
          <LibraryPane
            icon={<MoonStar className="h-4 w-4 text-bamboo" />}
            title={m.settings_about_title()}
            description={m.settings_about_description()}
            testId="settings-about-pane"
          >
            <section
              className="mt-3 space-y-3"
              data-testid="settings-about-section"
            >
              <p className="text-xs text-muted-foreground">
                {m.settings_about_version({ version: appVersion })}
              </p>
              <p className="border-t border-border/60 pt-3 text-xs leading-relaxed text-muted-foreground">
                {m.settings_about_extensions()}
              </p>
            </section>
          </LibraryPane>
        </div>
      )}
    </div>
  );
}
