import { act, renderHook, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test } from "vitest";
import { DEFAULT_FLOW_THEME_ID } from "@/lib/flow-theme";
import { useWidgetState, useWidgetTheme } from "./react";
import { resetWidgetRuntimeForTests } from "./runtime";

const BASE_CONTEXT = {
  schemaVersion: 1,
  hostApi: 1,
  id: "player",
  capabilities: ["widget.ui", "widget.state"],
  window: {
    label: "player",
    route: "player",
    title: "Lull 播放器",
    width: 880,
    height: 552,
    minWidth: 500,
    minHeight: 520,
    resizable: false,
    transparent: true,
  },
};

beforeEach(() => {
  window.localStorage.clear();
  window.__LULL_WIDGET__ = undefined;
  resetWidgetRuntimeForTests();
});

describe("widget react hooks", () => {
  test("没有 widget.theme 时退回宿主默认主题", () => {
    window.__LULL_WIDGET__ = BASE_CONTEXT;
    resetWidgetRuntimeForTests();

    const { result } = renderHook(() => useWidgetTheme());
    expect(result.current.themeId).toBe(DEFAULT_FLOW_THEME_ID);
    expect(result.current.theme).toBeDefined();
  });

  test("useWidgetState 读写命名空间内的 JSON 状态", () => {
    window.__LULL_WIDGET__ = BASE_CONTEXT;
    resetWidgetRuntimeForTests();

    const { result } = renderHook(() =>
      useWidgetState("player", "draft", { dwell: 1 }),
    );
    expect(result.current[0]).toEqual({ dwell: 1 });

    act(() => {
      result.current[1]({ dwell: 3 });
    });
    expect(result.current[0]).toEqual({ dwell: 3 });
    expect(window.localStorage.getItem("lull:player:draft")).toBe(
      '{"dwell":3}',
    );
  });

  test("挂载后读取已有状态", async () => {
    window.__LULL_WIDGET__ = BASE_CONTEXT;
    resetWidgetRuntimeForTests();
    window.localStorage.setItem("lull:player:draft", '{"dwell":9}');

    const { result } = renderHook(() =>
      useWidgetState("player", "draft", { dwell: 1 }),
    );
    await waitFor(() => expect(result.current[0]).toEqual({ dwell: 9 }));
  });

  test("缺少 widget.state 时只更新内存，不落盘", () => {
    window.__LULL_WIDGET__ = { ...BASE_CONTEXT, capabilities: ["widget.ui"] };
    resetWidgetRuntimeForTests();

    const { result } = renderHook(() =>
      useWidgetState("player", "draft", { dwell: 1 }),
    );
    act(() => {
      result.current[1]({ dwell: 2 });
    });
    expect(result.current[0]).toEqual({ dwell: 2 });
    expect(window.localStorage.getItem("lull:player:draft")).toBeNull();
  });
});
