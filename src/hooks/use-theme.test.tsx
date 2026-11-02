/**
 * 黑白样式的跨窗口同步：本地切换广播 Tauri 事件；其他窗口的广播或 storage
 * 事件都会更新当前窗口，并把 light / dark 落到 <html> 上。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import {
  THEME_CHANGED_EVENT,
  THEME_STORAGE_KEY,
  ThemeProvider,
  useTheme,
} from "./use-theme";

const bridge = vi.hoisted(() => ({
  emit: vi.fn((_event: string, _payload?: unknown) => Promise.resolve()),
  listeners: new Map<string, (event: { payload: unknown }) => void>(),
}));

vi.mock("@tauri-apps/api/event", () => ({
  emit: (event: string, payload?: unknown) => bridge.emit(event, payload),
  listen: (event: string, handler: (event: { payload: unknown }) => void) => {
    bridge.listeners.set(event, handler);
    return Promise.resolve(() => bridge.listeners.delete(event));
  },
}));

// 本测试固定按桌面窗口跑，才能验证 Tauri 广播链路。
vi.mock("@/core/window/controls", () => ({
  isDesktopWindow: () => true,
}));

function ThemeProbe() {
  const { theme, setTheme } = useTheme();
  return (
    <div>
      <span data-testid="theme">{theme}</span>
      <button type="button" onClick={() => setTheme("dark")}>
        dark
      </button>
    </div>
  );
}

function renderProbe() {
  return render(
    <ThemeProvider>
      <ThemeProbe />
    </ThemeProvider>,
  );
}

afterEach(() => {
  window.localStorage.clear();
  bridge.listeners.clear();
  bridge.emit.mockClear();
  document.documentElement.classList.remove(
    "light",
    "dark",
    "theme-transition",
  );
});

test("新窗口打开时按存储恢复黑白样式", async () => {
  window.localStorage.setItem(THEME_STORAGE_KEY, "dark");

  renderProbe();

  await waitFor(() => {
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("本窗口切换会广播事件并写入 ui-theme", async () => {
  renderProbe();

  fireEvent.click(screen.getByRole("button", { name: "dark" }));

  await waitFor(() => {
    expect(bridge.emit).toHaveBeenCalledWith(THEME_CHANGED_EVENT, {
      theme: "dark",
    });
  });
  expect(window.localStorage.getItem(THEME_STORAGE_KEY)).toBe("dark");
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("其他窗口的 Tauri 广播会同步当前窗口，且不会再次广播", async () => {
  renderProbe();
  await waitFor(() => {
    expect(bridge.listeners.has(THEME_CHANGED_EVENT)).toBe(true);
  });

  bridge.listeners.get(THEME_CHANGED_EVENT)?.({ payload: { theme: "dark" } });

  await waitFor(() => {
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
  expect(bridge.emit).not.toHaveBeenCalled();
});

test("storage 事件（浏览器多标签）同样会同步黑白样式", async () => {
  renderProbe();

  window.localStorage.setItem(THEME_STORAGE_KEY, "dark");
  window.dispatchEvent(
    new StorageEvent("storage", {
      key: THEME_STORAGE_KEY,
      newValue: "dark",
    }),
  );

  await waitFor(() => {
    expect(screen.getByTestId("theme").textContent).toBe("dark");
  });
  expect(document.documentElement.classList.contains("dark")).toBe(true);
});

test("非法广播值被忽略，不会把界面刷成无色", async () => {
  renderProbe();
  await waitFor(() => {
    expect(bridge.listeners.has(THEME_CHANGED_EVENT)).toBe(true);
  });

  bridge.listeners.get(THEME_CHANGED_EVENT)?.({ payload: { theme: "neon" } });

  expect(screen.getByTestId("theme").textContent).toBe("light");
  expect(document.documentElement.classList.contains("light")).toBe(true);
});
