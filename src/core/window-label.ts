/**
 * Tauri 当前窗口 label 的通用读取。
 *
 * 壁纸、游戏与场景事件都用 `emit_to(label)` 定向投递；前端监听必须带同一个
 * label（`AnyLabel`），否则 Tauri 默认的 `Any` 监听会收到所有窗口的事件。
 * 浏览器预览/单测里没有 `__TAURI_INTERNALS__`，返回 null。
 */
type TauriInternals = {
  metadata?: {
    currentWindow?: { label?: string };
  };
};

function internals(): TauriInternals | undefined {
  if (typeof window === "undefined") return undefined;
  return (window as Window & { __TAURI_INTERNALS__?: TauriInternals })
    .__TAURI_INTERNALS__;
}

/** 当前是否运行在 Tauri 壳里（浏览器预览/测试为 false）。 */
export function hasTauriRuntime(): boolean {
  return internals() !== undefined;
}

/** 当前 Tauri 窗口 label；浏览器预览或测试返回 null。 */
export function currentWindowLabel(): string | null {
  const label = internals()?.metadata?.currentWindow?.label;
  return typeof label === "string" && label.length > 0 ? label : null;
}
