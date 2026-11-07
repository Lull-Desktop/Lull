import { invoke } from "@tauri-apps/api/core";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";
import type { SlotInfo } from "@/lib/extensions";
import { SlotPanel } from "./slot-panel";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));

const activeSlot: SlotInfo = {
  id: "music-player",
  name: "音乐播放器",
  description: "选择音乐播放界面",
  category: "audio",
  status: "active",
  selected: "player",
  active: "player",
  visible: true,
  defaultProvider: "player",
  providers: [
    {
      id: "player",
      name: "播放器",
      version: "1.1.0",
      origin: "bundled",
      enabled: true,
      eligible: true,
      selected: true,
      active: true,
    },
    {
      id: "music-vinyl",
      name: "Vinyl Player",
      version: "1.0.0",
      origin: "user",
      enabled: true,
      eligible: true,
      selected: false,
      active: false,
    },
    {
      id: "music-broken",
      name: "Broken Player",
      version: "1.0.0",
      origin: "user",
      enabled: false,
      eligible: false,
      selected: false,
      active: false,
      reasonCode: "disabled",
      reason: "扩展未启用",
    },
  ],
};

const emptySlot: SlotInfo = {
  ...activeSlot,
  status: "empty",
  selected: undefined,
  active: undefined,
  visible: undefined,
  providers: [],
};

function renderPanel(slot: SlotInfo) {
  const onChanged = vi.fn(async () => {});
  const onMessage = vi.fn();
  const view = render(
    <SlotPanel
      slots={[slot]}
      busy={false}
      onChanged={onChanged}
      onMessage={onMessage}
    />,
  );
  return { onChanged, onMessage, rerender: view.rerender };
}

afterEach(() => {
  vi.clearAllMocks();
});

test("shows the current provider and slot status", () => {
  renderPanel(activeSlot);
  expect(screen.getByText("音乐播放器")).toBeDefined();
  expect(screen.getByText("运行中")).toBeDefined();
  expect(screen.getByText("播放器 1.1.0")).toBeDefined();
});

test("组件以紧凑列表展示当前实现与操作", () => {
  renderPanel(activeSlot);

  const list = screen.getByTestId("slot-list");
  expect(list.className).toContain("divide-y");

  const row = screen.getByTestId("slot-music-player");
  expect(row.className).toContain("py-2");
  expect(row.contains(screen.getByRole("button", { name: "切换实现" }))).toBe(
    true,
  );
  // 打开与关闭合并为同一个按钮：窗口可见时只保留「关闭窗口」。
  expect(row.contains(screen.getByRole("button", { name: "关闭窗口" }))).toBe(
    true,
  );
  expect(screen.queryByRole("button", { name: "打开" })).toBeNull();
  expect(row.contains(screen.getByRole("button", { name: "结束运行" }))).toBe(
    true,
  );
});

test("窗口可见时切换按钮执行关闭窗口", async () => {
  vi.mocked(invoke).mockResolvedValue(undefined);
  const { onChanged, onMessage } = renderPanel(activeSlot);

  const toggle = screen.getByRole("button", { name: "关闭窗口" });
  expect(toggle.className).toContain("border-input");
  expect(toggle.querySelector(".lucide-panel-top-close")).not.toBeNull();
  fireEvent.click(toggle);

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_close", { id: "player" });
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(onMessage).toHaveBeenCalledWith("关闭窗口");
});

test("关闭只隐藏窗口：status 仍 active、visible=false 时按钮回到「打开」", async () => {
  vi.mocked(invoke).mockResolvedValue(activeSlot);
  const { onChanged, onMessage } = renderPanel({
    ...activeSlot,
    visible: false,
  });

  const toggle = screen.getByRole("button", { name: "打开" });
  expect(screen.queryByRole("button", { name: "关闭窗口" })).toBeNull();
  expect(toggle.className).toContain("bg-primary");
  expect(toggle.querySelector(".lucide-panel-top-open")).not.toBeNull();
  fireEvent.click(toggle);

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_activate", {
      slot: "music-player",
    });
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(onMessage).toHaveBeenCalledWith("打开");
});

test("状态翻转后按钮的文案、图标与样式同步切换", () => {
  const { rerender } = renderPanel({ ...activeSlot, visible: false });

  const openToggle = screen.getByRole("button", { name: "打开" });
  expect(openToggle.querySelector(".lucide-panel-top-open")).not.toBeNull();
  expect(openToggle.className).toContain("bg-primary");

  rerender(
    <SlotPanel
      slots={[activeSlot]}
      busy={false}
      onChanged={vi.fn(async () => {})}
      onMessage={vi.fn()}
    />,
  );

  expect(screen.queryByRole("button", { name: "打开" })).toBeNull();
  const closeToggle = screen.getByRole("button", { name: "关闭窗口" });
  expect(closeToggle.querySelector(".lucide-panel-top-close")).not.toBeNull();
  expect(closeToggle.className).toContain("border-input");
});

test("启动失败时按钮显示「重试」，动作仍是激活槽位", async () => {
  vi.mocked(invoke).mockResolvedValue(activeSlot);
  renderPanel({ ...activeSlot, status: "failed", visible: false });

  expect(screen.queryByRole("button", { name: "打开" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "重试" }));

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_activate", {
      slot: "music-player",
    });
  });
});

test("switch sheet invokes slot use and refreshes", async () => {
  vi.mocked(invoke).mockResolvedValue({
    ...activeSlot,
    selected: "music-vinyl",
  });
  const { onChanged } = renderPanel(activeSlot);

  fireEvent.click(screen.getByRole("button", { name: "切换实现" }));
  expect(await screen.findByText("选择「音乐播放器」的实现")).toBeDefined();
  expect(screen.getByText("Broken Player")).toBeDefined();
  expect(screen.getByText("扩展未启用")).toBeDefined();

  const useButtons = screen.getAllByRole("button", {
    name: "使用并打开",
  });
  // 第一个可用项是官方 player；第二个是 music-vinyl。禁用的 broken 不能选。
  fireEvent.click(useButtons[1]);

  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_use", {
      slot: "music-player",
      id: "music-vinyl",
    });
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

test("deactivate keeps the window but stops the slot runtime", async () => {
  vi.mocked(invoke).mockResolvedValue({ ...activeSlot, status: "stopped" });
  const { onChanged } = renderPanel(activeSlot);

  fireEvent.click(screen.getByRole("button", { name: "结束运行" }));
  await waitFor(() => {
    expect(invoke).toHaveBeenCalledWith("extensions_slot_deactivate", {
      slot: "music-player",
    });
  });
  await waitFor(() => expect(onChanged).toHaveBeenCalled());
});

test("empty slot explains that an implementation must be chosen", () => {
  renderPanel(emptySlot);
  expect(screen.getByText("未选择实现")).toBeDefined();
  expect(
    screen.getAllByText(
      "该槽位还没有选择实现，可在扩展中心启用并选择一个扩展。",
    ).length,
  ).toBeGreaterThan(0);
});

test("showHeading=false 时由外层卡片提供标题，面板不重复渲染", () => {
  render(
    <SlotPanel
      slots={[activeSlot]}
      busy={false}
      onChanged={vi.fn(async () => {})}
      onMessage={vi.fn()}
      showHeading={false}
    />,
  );

  expect(screen.queryByText("功能槽位")).toBeNull();
  expect(screen.getByText("音乐播放器")).toBeDefined();
});
