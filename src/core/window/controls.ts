/**
 * 无边框窗口的 JS 侧操作封装：只在 Tauri 运行时调用原生 API，
 * 浏览器预览与单元测试里降级为 no-op，避免产生未捕获的 IPC rejection。
 */
import { invoke, isTauri } from "@tauri-apps/api/core";
import { PhysicalPosition, PhysicalSize } from "@tauri-apps/api/dpi";
import { emit, listen } from "@tauri-apps/api/event";
import {
  getCurrentWindow,
  type Window as TauriWindow,
} from "@tauri-apps/api/window";

/** 工具窗显示/隐藏后广播；与 Rust 侧 `widgets-changed` 同名。 */
const WIDGETS_CHANGED_EVENT = "widgets-changed";

/** 通知所有窗口：工具窗可见性变了（设置页据此刷新开关）。 */
export function notifyWidgetsChanged(): void {
  if (!isDesktopWindow()) return;
  void emit(WIDGETS_CHANGED_EVENT).catch((err: unknown) => {
    console.error("[window] 广播窗口状态失败", err);
  });
}

/** 当前是否运行在 Tauri WebView 中（纯浏览器 / jsdom 下为 false）。 */
export function isDesktopWindow(): boolean {
  try {
    return isTauri();
  } catch {
    return false;
  }
}

/**
 * 在当前窗口上执行一个原生操作。
 * 取句柄和调用本身都可能抛错（权限缺失、窗口已销毁、非 Tauri 环境），
 * 这里统一收敛成一条日志，调用方不需要再写 try/catch。
 */
function runOnWindow(
  action: (win: TauriWindow) => Promise<void>,
): Promise<void> {
  if (!isDesktopWindow()) return Promise.resolve();
  try {
    return action(getCurrentWindow()).catch((err: unknown) => {
      console.error("[window] 窗口操作失败", err);
    });
  } catch (err) {
    console.error("[window] 窗口句柄不可用", err);
    return Promise.resolve();
  }
}

/** 隐藏当前窗口：所有应用窗口的关闭按钮都走这里，应用与壁纸继续在托盘里运行。 */
export function hideWindow(): Promise<void> {
  return runOnWindow(async (win) => {
    await win.hide();
    // 顶栏关闭 = 隐藏，需要让设置页的「显示/关闭」开关同步。
    notifyWidgetsChanged();
  });
}

/** 最小化当前窗口（仅进任务栏的窗口提供该按钮）。 */
export function minimizeWindow(): Promise<void> {
  return runOnWindow((win) => win.minimize());
}

/** 白噪音顶部拖拽按钮：显式调用系统拖拽，而不是只依赖 data 属性。 */
export function startWindowDrag(): Promise<void> {
  return runOnWindow((win) => win.startDragging());
}

/** 开关窗口缩放：锁定浮窗时一并关掉边缘拖拽改尺寸。 */
export function setWindowResizable(resizable: boolean): Promise<void> {
  return runOnWindow((win) => win.setResizable(resizable));
}

/**
 * 一次 IPC 同时提交位置与尺寸；旧后端没有注册原子命令时回退到两步设置。
 */
async function applyWindowFrame(
  win: TauriWindow,
  x: number,
  y: number,
  width: number,
  height: number,
): Promise<void> {
  try {
    await invoke("window_set_frame", { x, y, width, height });
  } catch (error) {
    console.warn(
      "[window] 原子窗口帧不可用，回退到 setSize/setPosition",
      error,
    );
    await win.setSize(new PhysicalSize(width, height));
    await win.setPosition(new PhysicalPosition(x, y));
  }
}

/**
 * 只改窗口宽度，保持高度不动。
 * `anchor` 决定窗口的哪条竖边固定：
 * - left：固定左上角（右侧抽屉展开/收起）；
 * - right：固定右边缘。
 * 位置与尺寸通过 Rust 的一次 `SetWindowPos` 原子提交。
 */
export function setWindowWidth(
  width: number,
  anchor: "left" | "right" = "left",
): Promise<void> {
  return runOnWindow(async (win) => {
    const [size, scale, position] = await Promise.all([
      win.innerSize(),
      win.scaleFactor(),
      win.outerPosition(),
    ]);
    const targetWidth = Math.max(1, Math.round(width * scale));
    if (Math.abs(size.width - targetWidth) <= 1) return;
    const x =
      anchor === "right" ? position.x - (targetWidth - size.width) : position.x;
    await applyWindowFrame(win, x, position.y, targetWidth, size.height);
  });
}

/**
 * 换边时把窗口宽度和横向位置一起对齐，保持主球球心在屏幕上的坐标不变。
 * `playerAnchor` 是主球球心到窗口同侧边缘的 CSS 像素。
 */
export function alignPlayerWindow(
  currentSide: "left" | "right",
  nextSide: "left" | "right",
  targetWidth: number,
  playerAnchor: number,
): Promise<void> {
  return runOnWindow(async (win) => {
    const [size, scale, position] = await Promise.all([
      win.innerSize(),
      win.scaleFactor(),
      win.outerPosition(),
    ]);
    const currentWidth = size.width / scale;
    const targetPhysicalWidth = Math.max(1, Math.round(targetWidth * scale));
    const currentPlayerLocal =
      currentSide === "right" ? playerAnchor : currentWidth - playerAnchor;
    const nextPlayerLocal =
      nextSide === "right" ? playerAnchor : targetWidth - playerAnchor;
    const x =
      position.x + Math.round((currentPlayerLocal - nextPlayerLocal) * scale);
    if (
      Math.abs(size.width - targetPhysicalWidth) <= 1 &&
      Math.abs(x - position.x) <= 1
    ) {
      return;
    }
    await applyWindowFrame(
      win,
      x,
      position.y,
      targetPhysicalWidth,
      size.height,
    );
  });
}

/**
 * 当前窗口是否允许最小化。
 * 由窗口自身的 `minimizable` 能力决定（详见 src-tauri/src/window_host/spec.rs 的 WidgetSpec），
 * 顶栏据此决定是否渲染最小化按钮；不想要最小化的工具窗在 Rust 侧关掉即可。
 */
export function isWindowMinimizable(): Promise<boolean> {
  if (!isDesktopWindow()) return Promise.resolve(false);
  try {
    return getCurrentWindow()
      .isMinimizable()
      .catch(() => false);
  } catch {
    return Promise.resolve(false);
  }
}

/**
 * 订阅全局窗口偏好变化（任务栏 / 最小化开关）。
 * 偏好由设置窗写入并广播，各窗口顶栏据此重新读取 isMinimizable。
 * 返回取消订阅函数；浏览器或 jsdom 下为空操作。
 */
export function onWindowPrefsChanged(handler: () => void): () => void {
  if (!isDesktopWindow()) return () => {};
  let unlisten: (() => void) | null = null;
  let disposed = false;
  void listen("window-prefs-changed", handler)
    .then((stop) => {
      if (disposed) stop();
      else unlisten = stop;
    })
    .catch((err: unknown) => {
      console.error("[window] 订阅窗口偏好失败", err);
    });
  return () => {
    disposed = true;
    unlisten?.();
    unlisten = null;
  };
}
