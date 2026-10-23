/**
 * 设置窗口页面：偏好（主题 / 窗口 / 关于）、壁纸与扩展三个页签。
 * 壁纸层的显示与场景配置在 WallpaperPanel，本页只保留全局偏好卡片。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { AppWindow, MoonStar, Sparkles } from "lucide-react";
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
import { FLOW_THEMES } from "@/lib/flow-theme";
import { cn } from "@/lib/utils";
import { BUILTIN_WIDGETS } from "@/widgets/registry";

/** 与 Rust 侧 `window_prefs::WindowPrefs` 对应。 */
type WindowPrefs = {
  taskbarAndMinimize: boolean;
};

/** 与 Rust 侧 `window_host::WidgetState` 对应。 */
type WidgetState = {
  kind: string;
  visible: boolean;
};

/** 设置页可开关的内置工具窗（元数据来自 Widget SDK 注册表）。 */
const TOOL_WINDOWS = BUILTIN_WIDGETS.map((widget) => ({
  kind: widget.id,
  name: widget.name,
  description: widget.description ?? "",
}));

/** 设置页签，顺序即展示顺序：偏好 → 壁纸 → 扩展。 */
const SETTINGS_TABS = [
  { value: "preferences", label: "偏好" },
  { value: "wallpaper", label: "壁纸" },
  { value: "extensions", label: "扩展" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["value"];

/** 色板玻璃珠的自定义属性。 */
type FlowSwatchStyle = CSSProperties & {
  "--dot-a": string;
  "--dot-b": string;
};

export default function Settings() {
  const windowPrefsSwitchId = useId();
  const { themeId: flowThemeId, theme: flowTheme, setTheme } = useFlowTheme();
  const [windowPrefs, setWindowPrefs] = useState<WindowPrefs | null>(null);
  const [windowPrefsMsg, setWindowPrefsMsg] = useState("");
  const [widgetStates, setWidgetStates] = useState<Record<
    string,
    boolean
  > | null>(null);
  const [widgetMsg, setWidgetMsg] = useState("");
  const [tab, setTab] = useState<SettingsTab>("preferences");

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
        setWindowPrefsMsg(`保存失败：${String(err)}`);
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
          setWidgetMsg(`操作失败：${String(err)}`);
          refreshWidgets();
        },
      );
    },
    [refreshWidgets],
  );

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-4">
      <div
        className="mb-4 flex gap-1 rounded-full border border-border/60 bg-paper-warm/60 p-1 text-xs"
        role="tablist"
        aria-label="设置分区"
      >
        {SETTINGS_TABS.map(({ value, label }) => (
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
            {label}
          </button>
        ))}
      </div>

      {tab === "preferences" && (
        <main className="space-y-6">
          {/* ── Flow Theme（从白噪音迁移过来的全局主题流光）── */}
          <Card className="w-full">
            <CardHeader>
              <CardTitle className="flex items-center gap-2">
                <Sparkles className="h-5 w-5 text-bamboo" />
                主题流光
              </CardTitle>
              <CardDescription>
                白噪音的五套流光配色现在在这里统一管理；选择后立即驱动设置、播放器、番茄钟面板与白噪音
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-4">
              <fieldset className="m-0 flex min-w-0 flex-wrap items-center gap-2.5 border-0 p-0">
                <legend className="sr-only">主题流光</legend>
                {FLOW_THEMES.map((theme) => {
                  const active = theme.id === flowThemeId;
                  return (
                    <button
                      key={theme.id}
                      type="button"
                      aria-label={`主题流光：${theme.label}`}
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
                      {theme.label}
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
                    当前：
                    <strong className="font-medium">{flowTheme.label}</strong>
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
                    主按钮
                  </span>
                  <span className="rounded-full border border-bamboo/40 bg-bamboo-mist px-2.5 py-1 text-[10px] text-bamboo">
                    强调标签
                  </span>
                  <span className="ml-auto text-[10px] text-muted-foreground">
                    全局生效
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
                窗口
              </CardTitle>
              <CardDescription>
                所有 Lull 窗口共用的显示策略，修改后立即生效
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-3">
              <div className="flex items-center justify-between gap-4">
                <div className="space-y-1">
                  <Label
                    htmlFor={windowPrefsSwitchId}
                    className="text-ink-soft"
                  >
                    显示在任务栏并允许最小化
                  </Label>
                  <p className="text-xs text-muted-foreground">
                    关闭后所有窗口都不进任务栏，顶栏也不显示最小化按钮（仍可从托盘打开）
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
                  工具窗口（开启即显示，关闭即隐藏）
                </p>
                {TOOL_WINDOWS.map(({ kind, name, description }) => (
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
                      aria-label={`${name}窗口`}
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
                关于 Lull
              </CardTitle>
              <CardDescription>
                开源的助眠与专注桌面应用：壁纸、声场、番茄钟都在本地运行，不推送、不催促
              </CardDescription>
            </CardHeader>
            <CardContent className="space-y-2 text-xs text-muted-foreground">
              <p>
                版本 0.1.0 · GPL-3.0-or-later · SDK Apache-2.0 · Tauri 2 +
                Next.js 16 + Win32 Native Host
              </p>
              <p>
                扩展模型：壁纸内容与工具扩展在「扩展」页统一安装、启用与卸载；
                外部场景通过{" "}
                <code className="font-mono text-ink-soft">
                  content/catalog.json
                </code>{" "}
                发现，工具窗口由 Widget 清单声明。
              </p>
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
