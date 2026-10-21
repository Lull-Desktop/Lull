/**
 * 顶栏测试：验证锁定只切换拖拽区/窗口缩放、关闭隐藏窗口、锁定状态持久化，
 * 以及最小化按钮随窗口的 minimizable 能力出现。
 */
import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, expect, test, vi } from "vitest";
import { WindowTopbar } from "./window-topbar";

const tauriWindow = vi.hoisted(() => ({
  hide: vi.fn(() => Promise.resolve()),
  minimize: vi.fn(() => Promise.resolve()),
  setResizable: vi.fn(() => Promise.resolve()),
  isMinimizable: vi.fn(() => Promise.resolve(false)),
}));

vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true }));
vi.mock("@tauri-apps/api/event", () => ({
  listen: () => Promise.resolve(() => {}),
  emit: () => Promise.resolve(),
}));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => tauriWindow,
}));

function renderTopbar() {
  return render(<WindowTopbar />);
}

function topbar(): HTMLElement {
  return screen.getByTestId("window-topbar");
}

beforeEach(() => {
  window.localStorage.clear();
  vi.clearAllMocks();
});

test("解锁时顶栏是整条拖拽区（deep），锁定按钮为未按下", () => {
  renderTopbar();
  expect(topbar().getAttribute("data-tauri-drag-region")).toBe("deep");
  expect(screen.getByTestId("topbar-lock").getAttribute("aria-pressed")).toBe(
    "false",
  );
  // 胶囊常驻占位（未锁定时 invisible），保证锁定切换不会把基线行撑高导致文字跳动。
  expect(screen.getByText("已锁定").getAttribute("aria-hidden")).toBe("true");
});

test("点击锁定后移除拖拽区并禁止缩放，再次点击恢复", () => {
  renderTopbar();
  const lock = screen.getByTestId("topbar-lock");

  fireEvent.click(lock);
  expect(topbar().hasAttribute("data-tauri-drag-region")).toBe(false);
  expect(lock.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByText("已锁定").getAttribute("aria-hidden")).toBe("false");
  expect(tauriWindow.setResizable).toHaveBeenLastCalledWith(false);
  expect(window.localStorage.getItem("lull:window:locked")).toBe("1");

  fireEvent.click(lock);
  expect(topbar().getAttribute("data-tauri-drag-region")).toBe("deep");
  expect(tauriWindow.setResizable).toHaveBeenLastCalledWith(true);
  expect(window.localStorage.getItem("lull:window:locked")).toBe("0");
});

test("锁定状态跨挂载恢复：启动即锁定并关闭缩放", () => {
  window.localStorage.setItem("lull:window:locked", "1");
  renderTopbar();
  expect(topbar().hasAttribute("data-tauri-drag-region")).toBe(false);
  expect(tauriWindow.setResizable).toHaveBeenCalledWith(false);
});

test("关闭按钮调用 hide（隐藏到托盘，进程继续运行）", () => {
  renderTopbar();
  fireEvent.click(screen.getByTestId("topbar-close"));
  expect(tauriWindow.hide).toHaveBeenCalledTimes(1);
});

test("设置窗不请求最小化能力，因此不渲染最小化按钮", () => {
  render(<WindowTopbar section="设置" />);
  expect(tauriWindow.isMinimizable).not.toHaveBeenCalled();
  expect(screen.queryByTestId("topbar-minimize")).toBeNull();
});

test("允许最小化的窗口渲染最小化按钮并可调用", async () => {
  tauriWindow.isMinimizable.mockResolvedValueOnce(true);
  render(<WindowTopbar section="播放器" allowMinimize />);

  const button = await screen.findByTestId("topbar-minimize");
  expect(button.getAttribute("aria-label")).toBe("最小化");
  fireEvent.click(button);
  expect(tauriWindow.minimize).toHaveBeenCalledTimes(1);
});

test("不允许最小化的窗口（工具窗默认）没有最小化按钮", async () => {
  tauriWindow.isMinimizable.mockResolvedValueOnce(false);
  render(<WindowTopbar section="白噪音" allowMinimize />);

  // 等 isMinimizable 的 promise 落地，确认结果仍是「不渲染」。
  await vi.waitFor(() => {
    expect(tauriWindow.isMinimizable).toHaveBeenCalled();
  });
  expect(screen.queryByTestId("topbar-minimize")).toBeNull();
});
