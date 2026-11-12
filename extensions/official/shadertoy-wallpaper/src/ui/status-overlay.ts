/**
 * 壁纸内的状态层（RFC §9.2 / §9.3）。
 *
 * 宿主参数面板没有「场景 → 设置页」的状态通道，所以运行状态与错误必须显示在
 * 壁纸画面上；所有文本都用 `textContent` 写入，绝不拼 HTML 或注入用户源码。
 */
import {
  formatDiagnostic,
  type ShaderDiagnostic,
} from "../runtime/diagnostics";

export type OverlayState =
  | { kind: "hidden" }
  | { kind: "empty" }
  | { kind: "compiling" }
  | {
      kind: "error";
      diagnostic: ShaderDiagnostic;
      /** 旧 Program 是否仍在渲染。 */
      previousActive: boolean;
    }
  | { kind: "context-lost"; restoring: boolean }
  | { kind: "perf"; detail: string }
  | { kind: "notice"; title: string; detail: string };

export type StatusOverlay = {
  set(state: OverlayState): void;
  /** 显示临时提示，`ms` 毫秒后自动隐藏；后续 set/flash 会取消旧定时器。 */
  flash(state: OverlayState, ms?: number): void;
  dispose(): void;
};

const EMPTY_DETAIL =
  "未填写源码时壁纸运行内置示例（The Drive Home）。\n" +
  "在壁纸设置 → 着色器 → 源码中粘贴 GLSL，或从 .glsl/.frag 文件载入即可替换。\n" +
  "Paste GLSL or load a .glsl/.frag file in Wallpaper settings to replace the built-in demo.";

export function createStatusOverlay(root: HTMLElement): StatusOverlay {
  const title = root.ownerDocument.createElement("p");
  title.className = "shader-status-title";
  const detail = root.ownerDocument.createElement("pre");
  detail.className = "shader-status-detail";

  const card = root.ownerDocument.createElement("div");
  card.className = "shader-status-card";
  card.append(title, detail);
  root.replaceChildren(card);
  root.hidden = true;

  const show = (kind: string, titleText: string, detailText: string): void => {
    root.dataset.kind = kind;
    title.textContent = titleText;
    detail.textContent = detailText;
    root.hidden = false;
  };

  let timer: ReturnType<typeof setTimeout> | null = null;
  const clearTimer = (): void => {
    if (timer !== null) {
      clearTimeout(timer);
      timer = null;
    }
  };

  const apply = (state: OverlayState): void => {
    switch (state.kind) {
      case "hidden":
        root.hidden = true;
        return;
      case "empty":
        show("empty", "正在载入内置示例 / Loading built-in demo", EMPTY_DETAIL);
        return;
      case "compiling":
        show("compiling", "正在编译 / Compiling", "…");
        return;
      case "error": {
        const suffix = state.previousActive
          ? "\n\n旧着色器仍在运行。 / The previous shader keeps running."
          : "\n\n新着色器未启动。 / The shader was not started.";
        show(
          "error",
          "着色器未运行 / Shader not running",
          `${formatDiagnostic(state.diagnostic)}${suffix}`,
        );
        return;
      }
      case "context-lost":
        show(
          "context-lost",
          "WebGL 上下文丢失 / WebGL context lost",
          state.restoring
            ? "正在尝试恢复… / Trying to restore the context…"
            : "恢复失败，请重新加载壁纸。 / Restore failed; reload the wallpaper.",
        );
        return;
      case "perf":
        show(
          "perf",
          "性能不足，已停止渲染 / Stopped: GPU too slow",
          state.detail,
        );
        return;
      case "notice":
        show("notice", state.title, state.detail);
    }
  };

  return {
    set(state) {
      clearTimer();
      apply(state);
    },
    flash(state, ms = 5_000) {
      clearTimer();
      apply(state);
      timer = setTimeout(() => {
        timer = null;
        root.hidden = true;
      }, ms);
    },
    dispose() {
      clearTimer();
      root.hidden = true;
      root.replaceChildren();
    },
  };
}
