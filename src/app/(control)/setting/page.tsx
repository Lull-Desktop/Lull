/**
 * 设置窗口页面：偏好（主题 / 窗口 / 关于）、壁纸与扩展三个页签。
 * 壁纸层的显示与场景配置在 WallpaperPanel，本页只保留全局偏好卡片。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AppWindow, Languages, MoonStar, Sparkles } from "lucide-react";
import {
  type CSSProperties,
  useCallback,
  useEffect,
  useId,
  useState,
} from "react";
import { ExtensionsPanel } from "@/components/extensions/extensions-panel";
import { WallpaperPanel } from "@/components/settings/wallpaper-panel";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useFlowTheme } from "@/hooks/use-flow-theme";
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
import { FLOW_THEMES } from "@/lib/flow-theme";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";
import {
  BUILTIN_WIDGETS,
  widgetDisplayDescription,
  widgetDisplayName,
} from "@/widgets/registry";

/** 与 Rust 侧 `window_prefs::WindowPrefs` 对应。 */
type WindowPrefs = {
  taskbarAndMinimize: boolean;
};

/** 与 Rust 侧 `window_host::WidgetState` 对应。 */
type WidgetState = {
  kind: string;
  visible: boolean;
};

/** 设置页签，顺序即展示顺序：偏好 → 壁纸 → 扩展。文案在渲染时按当前语言取。 */
const SETTINGS_TABS = ["preferences", "wallpaper", "extensions"] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number];

const TAB_LABELS: Record<SettingsTab, () => string> = {
  preferences: m.settings_tab_preferences,
  wallpaper: m.settings_tab_wallpaper,
  extensions: m.settings_tab_extensions,
};

/** 色板玻璃珠的自定义属性。 */
type FlowSwatchStyle = CSSProperties & {
  "--dot-a": string;
  "--dot-b": string;
};

export default function Settings() {
  const windowPrefsSwitchId = useId();
  const locale = useLocale();
  const localeReady = useLocaleReady();
  const { themeId: flowThemeId, theme: flowTheme, setTheme } = useFlowTheme();
  const [windowPrefs, setWindowPrefs] = useState<WindowPrefs | null>(null);
  const [windowPrefsMsg, setWindowPrefsMsg] = useState("");
  const [widgetStates, setWidgetStates] = useState<Record<
    string,
    boolean
  > | null>(null);
  const [widgetMsg, setWidgetMsg] = useState("");
  const [tab, setTab] = useState<SettingsTab>("preferences");
  // 工具窗列表在渲染期取文案：语言切换后名称与描述要跟着变。
  const toolWindows = BUILTIN_WIDGETS.map((widget) => ({
    kind: widget.id,
    name: widgetDisplayName(widget),
    description: widgetDisplayDescription(widget),
  }));
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

  // 静态导出的预渲染 HTML 是基准语言，客户端首帧已是注入语言；
  // 挂载前不渲染文案，避免水合不匹配与错误语言闪烁。
  if (!localeReady) {
    return <div className="mx-auto w-full max-w-4xl px-4 py-4" />;
  }

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4">
      <div
        className="mb-4 flex gap-1 rounded-full border border-border/60 bg-paper-warm/60 p-1 text-xs"
        role="tablist"
        aria-label={m.settings_tabs_label()}
      >
        {SETTINGS_TABS.map((value) => (
          <button
            key={value}
            type="button"
            role="tab"
            aria-selected={tab === value}
            onClick={() => setTab(value)}
            className={`flex-1 rounded-full px-3 py-1.5 transition-colors ${
              tab === value
                ? "bg-paper text-ink shadow-sm"
                : "text-muted-foreground hover:text-ink-soft"
            }`}
          >
            {TAB_LABELS[value]()}
          </button>
        ))}
      </div>

      {tab === "preferences" && (
        <main className="space-y-6">
          {/* ── Language（界面语言，偏好以 Rust 的 preferences.json 为准）── */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Languages className="h-5 w-5 text-bamboo" />
                {m.settings_language_title()}
              </CardTitle>
              <CardDescription>
                {m.settings_language_description()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div
                role="radiogroup"
                aria-label={m.settings_language_title()}
                className="flex flex-wrap gap-2"
              >
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
              <p className="text-xs text-muted-foreground">
                {m.settings_language_effective({ locale: localeLabel(locale) })}
              </p>
              {languageMsg && (
                <p className="text-xs text-destructive">{languageMsg}</p>
              )}
            </CardContent>
          </Card>

          {/* ── Flow Theme（从白噪音迁移过来的全局主题流光）── */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-bamboo" />
                {m.settings_theme_title()}
              </CardTitle>
              <CardDescription>{m.settings_theme_description()}</CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
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

              <div
                className="overflow-hidden rounded-lg border border-paper-deep/60 bg-paper-warm/40 p-3"
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
            </CardContent>
          </Card>

          {/* ── Window Behavior（全局窗口偏好）── */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <AppWindow className="h-5 w-5 text-bamboo" />
                {m.settings_window_title()}
              </CardTitle>
              <CardDescription>
                {m.settings_window_description()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
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

              <div className="space-y-3 border-t border-border/50 pt-3">
                <p className="text-xs text-muted-foreground">
                  {m.settings_window_tools()}
                </p>
                {toolWindows.map(({ kind, name, description }) => (
                  <div key={kind} className="flex items-center justify-between">
                    <div className="space-y-0.5">
                      <span className="text-sm text-ink-soft">{name}</span>
                      {description && (
                        <p className="text-xs text-muted-foreground">
                          {description}
                        </p>
                      )}
                    </div>
                    <Switch
                      aria-label={m.settings_window_toggle_aria({ name })}
                      checked={widgetStates?.[kind] === true}
                      disabled={widgetStates === null}
                      onCheckedChange={(on) => toggleWidget(kind, on)}
                    />
                  </div>
                ))}
              </div>

              {windowPrefsMsg && (
                <p className="text-xs text-destructive">{windowPrefsMsg}</p>
              )}
              {widgetMsg && (
                <p className="text-xs text-destructive">{widgetMsg}</p>
              )}
            </CardContent>
          </Card>

          {/* ── About Lull（开源身份与扩展入口）── */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <MoonStar className="h-5 w-5 text-bamboo" />
                {m.settings_about_title()}
              </CardTitle>
              <CardDescription>
                {m.settings_about_description()}
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>{m.settings_about_version({ version: "0.1.0" })}</p>
              <p>{m.settings_about_extensions()}</p>
              <p className="font-mono text-[11px] text-ink-faint">
                logs: %TEMP%\lull · config: app_config_dir\display.json
              </p>
            </CardContent>
          </Card>

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
        </main>
      )}
      {tab === "wallpaper" && (
        <main className="space-y-6">
          <WallpaperPanel />
        </main>
      )}
      {tab === "extensions" && (
        <main className="space-y-6">
          <ExtensionsPanel
            onOpenWallpaperSettings={() => setTab("wallpaper")}
          />
        </main>
      )}
    </div>
  );
}
