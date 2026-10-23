/**
 * 主题流光：从白噪音抽出的全局流光配色。
 *
 * 参数集中在这里——设置窗口用它渲染色板，React hook 把同一组颜色写到
 * `<html>` 的 CSS 变量上，所有窗口（设置 / 播放器 / 番茄钟 / 白噪音）
 * 通过 `--flow-*` 与派生的 `--bamboo` / `--primary` 令牌统一换肤。
 */
import { m } from "@/paraglide/messages";

export type FlowThemeId = "blueGold" | "jade" | "amber" | "violet" | "aurora";

export type FlowTheme = {
  id: FlowThemeId;
  /** 配色名，取消息函数而不是字符串：语言切换后色板标签要跟着变。 */
  label: () => string;
  /** 流光三色：高光 / 氛围 / 尾色，用于玻璃件与面板渐变。 */
  a: string;
  b: string;
  c: string;
  /** 浅色纸面上的深色强调色（文字 / 主按钮）。 */
  accentLight: string;
  /** 深色模式下的亮色强调色。 */
  accentDark: string;
  /** 与 accentLight 搭配的前景色。 */
  onAccentLight: string;
  /** 与 accentDark 搭配的前景色。 */
  onAccentDark: string;
};

/**
 * 五个配色都来自白噪音原来的「主题流光」参数，顺序保持不变。
 * 新增配色时只需要在这里补一项：设置页色板与各窗口的 CSS 变量会自动跟上。
 */
export const FLOW_THEMES: readonly FlowTheme[] = [
  {
    id: "blueGold",
    label: m.flow_theme_blue_gold,
    a: "#ffe0a0",
    b: "#8fe4ff",
    c: "#b8a4ff",
    accentLight: "#2f7c93",
    accentDark: "#8fe4ff",
    onAccentLight: "#ffffff",
    onAccentDark: "#062126",
  },
  {
    id: "jade",
    label: m.flow_theme_forest,
    a: "#e8ffb8",
    b: "#8df0c1",
    c: "#8fe4ff",
    accentLight: "#2f7d5b",
    accentDark: "#8df0c1",
    onAccentLight: "#ffffff",
    onAccentDark: "#062117",
  },
  {
    id: "amber",
    label: m.flow_theme_warm_gold,
    a: "#ffd179",
    b: "#ff9d63",
    c: "#ffe7c0",
    accentLight: "#986229",
    accentDark: "#ffd179",
    onAccentLight: "#ffffff",
    onAccentDark: "#2a1606",
  },
  {
    id: "violet",
    label: m.flow_theme_star_violet,
    a: "#ff9ddd",
    b: "#b8a4ff",
    c: "#8fd7ff",
    accentLight: "#6f51a8",
    accentDark: "#c9b9ff",
    onAccentLight: "#ffffff",
    onAccentDark: "#1c1030",
  },
  {
    id: "aurora",
    label: m.flow_theme_aurora,
    a: "#a6a8ff",
    b: "#8dffe2",
    c: "#ffe0a0",
    accentLight: "#2f7b73",
    accentDark: "#8dffe2",
    onAccentLight: "#ffffff",
    onAccentDark: "#06211d",
  },
];

export const DEFAULT_FLOW_THEME_ID: FlowThemeId = "blueGold";

/** localStorage 是各窗口共享的持久层；Tauri 事件只负责实时广播。 */
export const FLOW_THEME_STORAGE_KEY = "lull:flow-theme";

/** 与 Rust 侧已有的 `window-prefs-changed` 同风格，由前端 emit / listen。 */
export const FLOW_THEME_CHANGED_EVENT = "flow-theme-changed";

export function isFlowThemeId(value: unknown): value is FlowThemeId {
  return (
    typeof value === "string" && FLOW_THEMES.some((theme) => theme.id === value)
  );
}

/** 非法 / 缺失的 id 一律回退到默认的蓝金，避免脏存储把界面刷成无色。 */
export function getFlowTheme(id: string | null | undefined): FlowTheme {
  return FLOW_THEMES.find((theme) => theme.id === id) ?? FLOW_THEMES[0];
}

export function readStoredFlowThemeId(): FlowThemeId {
  if (typeof window === "undefined") return DEFAULT_FLOW_THEME_ID;
  try {
    const stored = window.localStorage.getItem(FLOW_THEME_STORAGE_KEY);
    return isFlowThemeId(stored) ? stored : DEFAULT_FLOW_THEME_ID;
  } catch {
    return DEFAULT_FLOW_THEME_ID;
  }
}

export function persistFlowThemeId(id: FlowThemeId): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(FLOW_THEME_STORAGE_KEY, id);
  } catch {
    // 存储被禁用时只影响下次启动的默认值，当前窗口仍按选择换肤。
  }
}

/** 主题色写到 `<html>` 的内联变量；CSS 里的缺省值负责 JS 运行前的兜底。 */
export function flowThemeCssVariables(
  theme: FlowTheme,
): Record<string, string> {
  return {
    "--flow-a": theme.a,
    "--flow-b": theme.b,
    "--flow-c": theme.c,
    "--flow-accent-light": theme.accentLight,
    "--flow-accent-dark": theme.accentDark,
    "--flow-on-accent-light": theme.onAccentLight,
    "--flow-on-accent-dark": theme.onAccentDark,
  };
}

export function applyFlowThemeToDocument(theme: FlowTheme): void {
  if (typeof document === "undefined") return;
  const root = document.documentElement;
  root.dataset.flowTheme = theme.id;
  for (const [name, value] of Object.entries(flowThemeCssVariables(theme))) {
    root.style.setProperty(name, value);
  }
}
