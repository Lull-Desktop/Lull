import { beforeEach, describe, expect, test, vi } from "vitest";
import { diagnostic } from "../runtime/diagnostics";
import { createStatusOverlay } from "./status-overlay";

function makeRoot(): HTMLElement {
  const root = document.createElement("div");
  document.body.append(root);
  return root;
}

describe("createStatusOverlay", () => {
  let root: HTMLElement;

  beforeEach(() => {
    document.body.replaceChildren();
    root = makeRoot();
  });

  test("shows the empty hint and hides on demand", () => {
    const overlay = createStatusOverlay(root);
    expect(root.hidden).toBe(true);
    overlay.set({ kind: "empty" });
    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain("未加载着色器");
    overlay.set({ kind: "hidden" });
    expect(root.hidden).toBe(true);
  });

  test("renders compiler logs as text, never as HTML", () => {
    const overlay = createStatusOverlay(root);
    overlay.set({
      kind: "error",
      diagnostic: diagnostic(
        "compile-failed",
        "着色器编译失败",
        '<img src=x onerror="alert(1)"> ERROR: 0:12',
        24,
      ),
      previousActive: true,
    });
    expect(root.querySelector("img")).toBeNull();
    expect(root.textContent).toContain("<img src=x");
    expect(root.textContent).toContain("ERROR: 0:12");
    expect(root.textContent).toContain("24 行");
    expect(root.textContent).toContain("旧着色器仍在运行");
    expect(root.dataset.kind).toBe("error");
  });

  test("distinguishes context loss and performance stop", () => {
    const overlay = createStatusOverlay(root);
    overlay.set({ kind: "context-lost", restoring: false });
    expect(root.textContent).toContain("WebGL 上下文丢失");
    overlay.set({ kind: "perf", detail: "平均帧耗时 300 ms" });
    expect(root.textContent).toContain("性能不足");
    expect(root.textContent).toContain("300 ms");
  });

  test("flash hides the notice after the timeout", () => {
    vi.useFakeTimers();
    const overlay = createStatusOverlay(root);
    overlay.flash({ kind: "notice", title: "占位输入", detail: "正文" }, 1_000);
    expect(root.hidden).toBe(false);
    expect(root.textContent).toContain("占位输入");

    vi.advanceTimersByTime(1_000);
    expect(root.hidden).toBe(true);
    vi.useRealTimers();
  });

  test("dispose removes the card", () => {
    const overlay = createStatusOverlay(root);
    overlay.set({ kind: "notice", title: "提示", detail: "正文" });
    overlay.dispose();
    expect(root.hidden).toBe(true);
    expect(root.childElementCount).toBe(0);
  });
});
