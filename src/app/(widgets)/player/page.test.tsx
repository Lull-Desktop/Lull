/**
 * 播放器页测试：默认在线精选、本地空态、播放模式与进度 / 音量控件的可访问语义。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, expect, test } from "vitest";
import PlayerPage from "./page";

beforeEach(() => {
  window.localStorage.clear();
});

test("默认载入在线精选，主球播放按钮可用", () => {
  render(<PlayerPage />);

  // 主球标题与列表第一行都会出现同一首曲目。
  expect(screen.getAllByText("Beyond the Horizon").length).toBeGreaterThan(0);
  expect(screen.getAllByText("Aurora Lane").length).toBeGreaterThan(0);
  expect(
    screen.getByRole("button", { name: /^播放：Beyond the Horizon/ }),
  ).toBeDefined();
  expect(
    screen.getByRole("tab", { name: "在线" }).getAttribute("aria-selected"),
  ).toBe("true");
});

test("切到本地来源时展示空态与导入入口", () => {
  render(<PlayerPage />);

  fireEvent.click(screen.getByRole("tab", { name: "本地" }));
  expect(screen.getByText("本地曲库还空着")).toBeDefined();
  expect(screen.getByRole("button", { name: "导入音频" })).toBeDefined();
  expect(screen.getByRole("button", { name: "添加本地音频" })).toBeDefined();
});

test("右上曲库泡切换抽屉展开状态", () => {
  render(<PlayerPage />);

  const library = screen.getByRole("button", { name: "曲库" });
  expect(library.getAttribute("aria-expanded")).toBe("true");

  fireEvent.click(library);
  expect(library.getAttribute("aria-expanded")).toBe("false");

  fireEvent.click(library);
  expect(library.getAttribute("aria-expanded")).toBe("true");
});

test("三态循环泡可切到单曲循环", () => {
  render(<PlayerPage />);

  const repeatOne = screen.getByRole("button", { name: "单曲循环" });
  fireEvent.click(repeatOne);
  expect(repeatOne.getAttribute("aria-pressed")).toBe("true");
  expect(
    screen
      .getByRole("button", { name: "顺序播放" })
      .getAttribute("aria-pressed"),
  ).toBe("false");
});

test("进度环与音量滑杆保留可访问值与键盘语义", () => {
  render(<PlayerPage />);

  const progress = screen.getByRole("slider", { name: "播放进度" });
  expect(progress.getAttribute("aria-valuetext")).toBe("00:00 / 04:12");
  const volume = screen.getByRole("slider", { name: "音量" });
  expect(volume.getAttribute("aria-valuenow")).toBe("78");
  expect(volume.getAttribute("aria-orientation")).toBe("horizontal");
  expect(screen.getByRole("button", { name: "静音" })).toBeDefined();
  expect(screen.getByRole("button", { name: "关闭窗口" })).toBeDefined();

  fireEvent.keyDown(progress, { key: "ArrowRight" });
  expect(progress.getAttribute("aria-valuetext")).toBe("00:05 / 04:12");

  fireEvent.keyDown(volume, { key: "ArrowUp" });
  expect(volume.getAttribute("aria-valuenow")).toBe("83");
});

test("曲库弹出方向可切到左侧，抽屉保持展开", async () => {
  render(<PlayerPage />);

  const sideToggle = screen.getByRole("button", {
    name: "曲库改从左侧弹出",
  });
  fireEvent.click(sideToggle);

  await waitFor(() => {
    expect(
      screen.getByRole("button", { name: "曲库改从右侧弹出" }),
    ).toBeDefined();
    expect(
      screen.getByRole("button", { name: "曲库" }).hasAttribute("disabled"),
    ).toBe(false);
    expect(
      document.querySelector(".liquid-player-root")?.getAttribute("data-dock"),
    ).toBe("left");
  });
  expect(
    screen.getByRole("button", { name: "曲库" }).getAttribute("aria-expanded"),
  ).toBe("true");

  const library = screen.getByRole("button", { name: "曲库" });
  fireEvent.click(library);
  expect(library.getAttribute("aria-expanded")).toBe("false");
  fireEvent.click(library);
  await waitFor(() => {
    expect(library.getAttribute("aria-expanded")).toBe("true");
  });
});

test("换边先隐藏旧播放器，窗口移动完成后才翻转布局", async () => {
  render(<PlayerPage />);
  const root = document.querySelector(".liquid-player-root");

  fireEvent.click(screen.getByRole("button", { name: "曲库改从左侧弹出" }));

  // 第一拍：旧播放器进入 leaving，布局仍停在右停靠。
  expect(root?.getAttribute("data-dock-leaving")).toBe("true");
  expect(root?.getAttribute("data-dock")).toBe("right");
  expect(root?.getAttribute("data-dock-switching")).toBe("false");

  // 第二拍：窗口对齐后翻布局，才开始 materialize。
  await waitFor(
    () => {
      expect(root?.getAttribute("data-dock")).toBe("left");
    },
    { timeout: 2500 },
  );
  expect(root?.getAttribute("data-dock-leaving")).toBe("false");
  expect(root?.getAttribute("data-dock-switching")).toBe("true");
});
