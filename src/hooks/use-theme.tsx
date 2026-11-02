/**
 * 控制窗口主题上下文：提供明暗主题读取、切换与持久化，并处理水合安全的初始化。
 *
 * 明暗是跨窗口偏好：切换后除了本窗口，还要通过 Tauri 事件（并用 localStorage
 * 的 storage 事件兜底浏览器多标签）通知已经打开的其他窗口——例如在设置窗切到
 * 深色时，一直开着的曲库窗口也要一起变。
 */
"use client";

import { emit, listen } from "@tauri-apps/api/event";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { isDesktopWindow } from "@/core/window/controls";

export type Theme = "dark" | "light";

/** localStorage 键：各窗口共享同一份存储，新窗口据此恢复上次的黑白样式。 */
export const THEME_STORAGE_KEY = "ui-theme";

/** 跨窗口广播事件；与 flow-theme-changed 同风格，由前端 emit / listen。 */
export const THEME_CHANGED_EVENT = "ui-theme-changed";

export function isTheme(value: unknown): value is Theme {
  return value === "dark" || value === "light";
}

/** 读取持久化主题；非法值或存储不可用时退回默认，避免把脏字符串直接当主题用。 */
function readStoredTheme(storageKey: string, fallback: Theme): Theme {
  try {
    const stored = window.localStorage.getItem(storageKey);
    return isTheme(stored) ? stored : fallback;
  } catch {
    return fallback;
  }
}

/**
 * 广播给已打开的其他窗口。emit 只在 Tauri 内可用；浏览器预览 / 单测里退回
 * localStorage 的 storage 事件，不会产生 IPC rejection。
 */
function broadcastTheme(theme: Theme): void {
  if (!isDesktopWindow()) return;
  void emit(THEME_CHANGED_EVENT, { theme }).catch((err: unknown) => {
    console.error("[theme] 广播黑白样式失败", err);
  });
}

type ThemeProviderProps = {
  children: React.ReactNode;
  defaultTheme?: Theme;
  storageKey?: string;
};

type ThemeProviderState = {
  theme: Theme;
  setTheme: (theme: Theme) => void;
};

const ThemeProviderContext = createContext<ThemeProviderState | undefined>(
  undefined,
);

const TRANSITION_MS = 350;

export function ThemeProvider({
  children,
  defaultTheme = "light",
  storageKey = THEME_STORAGE_KEY,
  ...props
}: ThemeProviderProps) {
  const [theme, setThemeState] = useState<Theme>(defaultTheme);
  // 初始渲染与 SSR 保持一致；读完 localStorage 才允许回写，避免首个 effect 用默认值覆盖已存主题。
  const [hydrated, setHydrated] = useState(false);
  const transitionTimer = useRef<number | null>(null);

  useEffect(() => {
    setThemeState(readStoredTheme(storageKey, defaultTheme));
    setHydrated(true);
  }, [storageKey, defaultTheme]);

  const setTheme = useCallback((newTheme: Theme) => {
    const root = window.document.documentElement;
    root.classList.add("theme-transition");
    setThemeState(newTheme);
    // 立即广播，不等 React 提交：另一个窗口的切换与当前窗口同步发生。
    broadcastTheme(newTheme);
    if (transitionTimer.current !== null) {
      window.clearTimeout(transitionTimer.current);
    }
    transitionTimer.current = window.setTimeout(() => {
      root.classList.remove("theme-transition");
      transitionTimer.current = null;
    }, TRANSITION_MS);
  }, []);

  useEffect(() => {
    const root = window.document.documentElement;
    root.classList.remove("light", "dark");
    root.classList.add(theme);
    if (!hydrated) return;
    try {
      window.localStorage.setItem(storageKey, theme);
    } catch {
      // 存储被禁用时不影响当前会话的主题。
    }
  }, [theme, storageKey, hydrated]);

  // 跟随其他窗口的切换：Tauri 事件负责已打开的窗口，storage 事件兜底浏览器多标签。
  // 这里只更新状态，不再广播，避免两个窗口互相触发形成回环。
  useEffect(() => {
    const applyExternalTheme = (next: Theme): void => {
      setThemeState((current) => (current === next ? current : next));
    };

    const onStorage = (event: StorageEvent): void => {
      if (event.key !== storageKey || !isTheme(event.newValue)) return;
      applyExternalTheme(event.newValue);
    };
    window.addEventListener("storage", onStorage);

    let disposed = false;
    let stopTauriListener: (() => void) | null = null;
    if (isDesktopWindow()) {
      void listen<{ theme?: unknown }>(THEME_CHANGED_EVENT, (event) => {
        const next = event.payload?.theme;
        if (isTheme(next)) applyExternalTheme(next);
      })
        .then((stop) => {
          if (disposed) stop();
          else stopTauriListener = stop;
        })
        .catch((err: unknown) => {
          console.error("[theme] 订阅黑白样式失败", err);
        });
    }

    return () => {
      disposed = true;
      window.removeEventListener("storage", onStorage);
      stopTauriListener?.();
      stopTauriListener = null;
    };
  }, [storageKey]);

  // 卸载时清掉未触发的过渡计时器，避免把 theme-transition 永久留在 <html> 上。
  useEffect(
    () => () => {
      if (transitionTimer.current !== null) {
        window.clearTimeout(transitionTimer.current);
        transitionTimer.current = null;
        window.document.documentElement.classList.remove("theme-transition");
      }
    },
    [],
  );

  const value = useMemo(() => ({ theme, setTheme }), [theme, setTheme]);

  return (
    <ThemeProviderContext.Provider {...props} value={value}>
      {children}
    </ThemeProviderContext.Provider>
  );
}

export const useTheme = () => {
  const context = useContext(ThemeProviderContext);

  if (context === undefined)
    throw new Error("useTheme must be used within a ThemeProvider");

  return context;
};
