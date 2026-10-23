/**
 * 界面语言的唯一入口：快照、切换、跨窗口同步与 `m.xxx()` 的取值来源。
 *
 * 设计要点：
 * - **事实源在 Rust**：`app_config_dir/preferences.json`，启动时解析后通过
 *   `initialization_script` 注入 `window.__LULL_LOCALE__`（先于页面 JS 执行），
 *   所以这里是同步读取，没有异步等待、没有首帧语言跳变。
 * - **不用 Paraglide 的 `setLocale`**：它默认会重载文档（壁纸窗重载会黑闪），
 *   `{ reload: false }` 又依赖内部异步状态。这里直接把 `getLocale` 换成读本模块
 *   的同步变量，消息函数立刻返回新语言，重渲染由 React 订阅驱动。
 * - **跨窗口**：Rust 写盘后广播 `i18n-locale-changed`，所有窗口以广播为最终态。
 */
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { useSyncExternalStore } from "react";
import { isDesktopWindow } from "@/core/window/controls";
import {
  baseLocale,
  isLocale,
  overwriteGetLocale,
  type Locale,
} from "@/paraglide/runtime";

/** Rust 广播的语言变更事件。 */
export const LOCALE_CHANGED_EVENT = "i18n-locale-changed";

/** 浏览器预览（非 Tauri）时的兜底存储；桌面端的持久化在 preferences.json。 */
export const LOCALE_STORAGE_KEY = "lull.locale";

/** 用户偏好：「跟随系统」或某个具体语言。 */
export type LocalePreference = Locale | "system";

/** 与 Rust 侧 `i18n::LocaleState` 对应。 */
export type LocaleState = {
  locale: Locale;
  supported: Locale[];
  explicit: boolean;
};

declare global {
  interface Window {
    /** Rust 建窗时注入；缺失说明是浏览器预览或旧版本宿主。 */
    __LULL_LOCALE__?: string;
  }
}

/** 语言自称：切换器里每项永远用它自己的文字，不翻译。 */
const LOCALE_LABELS: Record<Locale, string> = {
  "zh-CN": "简体中文",
  "en-US": "English",
};

export const LOCALE_OPTIONS: readonly Locale[] = ["zh-CN", "en-US"];

export function localeLabel(locale: Locale): string {
  return LOCALE_LABELS[locale] ?? locale;
}

/**
 * 把外部输入收敛到受支持的语言。
 *
 * 目前只提供简体中文与英文：所有 `zh` 变体（含繁体）统一落到 `zh-CN`，
 * 繁体用户看到简体，而不是被丢回英文。重新引入繁体时在这里恢复字形判断，
 * 注意 `zh-Hant` / `zh-TW` / `zh-HK` / `zh-MO` 必须先于宽泛的 `zh`。
 * Rust 侧 `normalize` 是同一套规则。
 */
export function normalizeLocale(value: unknown): Locale | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  if (text === "") return null;
  if (isLocale(text)) return text;

  const lower = text.toLowerCase();
  if (lower.startsWith("zh")) return "zh-CN";
  if (lower.startsWith("en")) return "en-US";
  return null;
}

function detectFromNavigator(): Locale | null {
  if (typeof navigator === "undefined") return null;
  const candidates = navigator.languages ?? [navigator.language];
  for (const candidate of candidates) {
    const locale = normalizeLocale(candidate);
    if (locale) return locale;
  }
  return null;
}

function bootLocale(): Locale {
  if (typeof window === "undefined") return baseLocale;
  // 刻意不看 navigator：桌面窗口的语言由 Rust 注入，浏览器预览与单测固定基准语言，
  // 否则同一份代码在不同机器上渲染出不同语言，测试与截图都不可复现。
  return (
    normalizeLocale(window.__LULL_LOCALE__) ??
    normalizeLocale(readLocalMirror()) ??
    baseLocale
  );
}

function readLocalMirror(): string | null {
  try {
    return window.localStorage.getItem(LOCALE_STORAGE_KEY);
  } catch {
    return null;
  }
}

function writeLocalMirror(locale: Locale): void {
  try {
    window.localStorage.setItem(LOCALE_STORAGE_KEY, locale);
  } catch {
    // 隐私模式 / 存储被禁用：仅影响浏览器预览，桌面端不需要它。
  }
}

let currentLocale: Locale = bootLocale();
let currentExplicit = true;
const subscribers = new Set<() => void>();

function emitChange(): void {
  for (const listener of subscribers) listener();
}

function applyLocale(locale: Locale, explicit?: boolean): void {
  const changed = locale !== currentLocale;
  currentLocale = locale;
  if (explicit !== undefined) currentExplicit = explicit;
  if (
    typeof document !== "undefined" &&
    document.documentElement.lang !== locale
  ) {
    document.documentElement.lang = locale;
  }
  if (changed) emitChange();
}

// 模块求值即生效：先于任何 `m.xxx()` 调用，保证首屏就是正确语言。
if (typeof window !== "undefined") {
  overwriteGetLocale(() => currentLocale);
  if (document.documentElement.lang !== currentLocale) {
    document.documentElement.lang = currentLocale;
  }
}

/** 其他窗口切换语言后，本窗口跟进（幂等）。 */
function onExternalLocale(payload: unknown): void {
  const record = payload as { locale?: unknown; explicit?: unknown } | null;
  const locale = normalizeLocale(record?.locale);
  if (!locale) return;
  writeLocalMirror(locale);
  applyLocale(
    locale,
    typeof record?.explicit === "boolean" ? record.explicit : undefined,
  );
}

let detach: (() => void) | null = null;

function attach(): void {
  if (typeof window === "undefined" || detach) return;
  const onStorage = (event: StorageEvent): void => {
    if (event.key !== LOCALE_STORAGE_KEY) return;
    const locale = normalizeLocale(event.newValue);
    if (locale) applyLocale(locale);
  };
  window.addEventListener("storage", onStorage);

  let disposed = false;
  let stopTauri: (() => void) | null = null;
  if (isDesktopWindow()) {
    void listen<unknown>(LOCALE_CHANGED_EVENT, (event) =>
      onExternalLocale(event.payload),
    )
      .then((stop) => {
        if (disposed) stop();
        else stopTauri = stop;
      })
      .catch((error: unknown) => {
        console.error("[i18n] 订阅语言变更失败", error);
      });
  }

  detach = () => {
    disposed = true;
    window.removeEventListener("storage", onStorage);
    stopTauri?.();
    stopTauri = null;
  };
}

function subscribe(listener: () => void): () => void {
  subscribers.add(listener);
  if (subscribers.size === 1) attach();
  return () => {
    subscribers.delete(listener);
    if (subscribers.size === 0) {
      detach?.();
      detach = null;
    }
  };
}

function getSnapshot(): Locale {
  return currentLocale;
}

/** 服务端 / 预渲染阶段（静态导出）恒为基准语言；水合由 LocaleGate 挡住。 */
function getServerSnapshot(): Locale {
  return baseLocale;
}

/** 当前语言。组件调用它即可在语言切换时重渲染。 */
export function useLocale(): Locale {
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** 当前是否「跟随系统」。 */
export function useLocalePreference(): LocalePreference {
  const locale = useLocale();
  return currentExplicit ? locale : "system";
}

export function currentLocaleValue(): Locale {
  return currentLocale;
}

export function localeStateOf(locale: Locale, explicit: boolean): LocaleState {
  return { locale, supported: [...LOCALE_OPTIONS], explicit };
}

/**
 * 切换界面语言：交给 Rust 写盘 + 广播（所有窗口以广播为最终态）。
 * `preference` 传 "system" 表示跟随系统语言。
 */
export async function setLocalePreference(
  preference: LocalePreference,
): Promise<LocaleState> {
  if (typeof window === "undefined") {
    return localeStateOf(currentLocale, currentExplicit);
  }
  if (!isDesktopWindow()) {
    // 浏览器预览：没有 Rust，只能就地切换（不持久化到 preferences.json）。
    const locale =
      preference === "system"
        ? (detectFromNavigator() ?? baseLocale)
        : preference;
    writeLocalMirror(locale);
    applyLocale(locale, preference !== "system");
    return localeStateOf(locale, preference !== "system");
  }

  const state = await invoke<LocaleState>("i18n_set_locale", {
    locale: preference,
  });
  const locale = normalizeLocale(state.locale) ?? currentLocale;
  writeLocalMirror(locale);
  applyLocale(locale, state.explicit);
  return { ...state, locale, supported: [...LOCALE_OPTIONS] };
}

/**
 * 启动时向 Rust 校准一次（读 preferences.json 的解析结果）。
 *
 * 注入脚本已经给了同一个值，这里主要是为了让「跟随系统 / 具体语言」的
 * 偏好状态可信，以及在没有注入的浏览器预览里补一次数据。
 */
export async function syncLocaleFromHost(): Promise<LocaleState | null> {
  if (!isDesktopWindow()) return null;
  try {
    const state = await invoke<LocaleState>("i18n_boot");
    const locale = normalizeLocale(state.locale);
    if (locale) {
      writeLocalMirror(locale);
      applyLocale(locale, state.explicit);
    }
    return state;
  } catch (error) {
    console.error("[i18n] 读取语言偏好失败", error);
    return null;
  }
}

/** 仅测试用：把模块快照重置到基准语言。 */
export function resetLocaleForTest(locale: Locale = baseLocale): void {
  currentLocale = locale;
  currentExplicit = true;
  emitChange();
}
