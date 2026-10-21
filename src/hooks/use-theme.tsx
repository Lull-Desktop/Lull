/**
 * 控制窗口主题上下文：提供明暗主题读取、切换与持久化，并处理水合安全的初始化。
 */
"use client";

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";

export type Theme = "dark" | "light";

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
  storageKey = "ui-theme",
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
