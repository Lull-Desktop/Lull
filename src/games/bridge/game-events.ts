/**
 * 游戏事件的窗口定向监听。
 *
 * Tauri JS `listen` 默认注册 `EventTarget::Any`；Rust `emit_to(label)` 的
 * 过滤对 `Any` 监听器无条件通过，意味着每个窗口都会收到所有游戏的事件。
 * 独立模式多游戏同时运行时，authority / replica / controller 会互相消费
 * 对方的 tick、command、snapshot，表现为状态串台。游戏事件必须显式把
 * 当前窗口 label 作为监听目标。
 */
import {
  type EventCallback,
  listen,
  type UnlistenFn,
} from "@tauri-apps/api/event";
import { currentWindowLabel, hasTauriRuntime } from "@/core/window-label";

export { currentWindowLabel };

/**
 * 监听定向到当前窗口的宿主事件。
 *
 * Tauri 内必须带 label，否则会退回全局 `Any` 监听并收到其它窗口的事件。
 * 浏览器预览/单测没有 Tauri event 系统，保留默认监听便于 mock 与调试。
 */
export function listenGameEvent<T>(
  event: string,
  handler: EventCallback<T>,
): Promise<UnlistenFn> {
  const label = currentWindowLabel();
  if (label) {
    return listen<T>(event, handler, {
      // 与 Rust `emit_to(label)` 的 AnyLabel 目标精确匹配。
      target: { kind: "AnyLabel", label },
    });
  }
  if (hasTauriRuntime()) {
    console.error(
      `[game] 当前窗口没有 label，拒绝全局监听 ${event}（会导致多游戏串台）`,
    );
    return Promise.resolve(() => {});
  }
  return listen<T>(event, handler);
}

/** 事件载荷是否属于指定游戏；用于 snapshot/event/render/lifecycle 双保险。 */
export function isGameEventForGame(payload: unknown, gameId: string): boolean {
  if (typeof payload !== "object" || payload === null) return false;
  return (payload as { gameId?: unknown }).gameId === gameId;
}
