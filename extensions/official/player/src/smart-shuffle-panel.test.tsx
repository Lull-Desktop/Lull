import { DEFAULT_SMART_SHUFFLE_CONFIG } from "@lull/media-sdk";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { expect, test, vi } from "vitest";
import { SmartShufflePanel } from "./smart-shuffle-panel";

function renderPanel() {
  const onChange = vi.fn();
  const onClose = vi.fn();
  const onNotice = vi.fn();
  render(
    <SmartShufflePanel
      config={DEFAULT_SMART_SHUFFLE_CONFIG}
      onChange={onChange}
      onClose={onClose}
      onNotice={onNotice}
    />,
  );
  return { onChange, onClose, onNotice };
}

test("面板只展示五个听感滑杆与固定约束说明", () => {
  renderPanel();
  expect(screen.getAllByRole("slider")).toHaveLength(5);
  expect(screen.getByText(/一轮内不重复/)).toBeTruthy();
  expect(screen.queryByText(/BPM/)).toBeNull();
});

test("选择预设会提交整套听感参数", () => {
  const { onChange } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "多样性优先" }));
  const next = onChange.mock.calls[0]?.[0];
  expect(next.experience).toEqual({
    randomness: 40,
    diversity: 100,
    repeatAvoidance: 90,
  });
  expect(next.separation).toEqual({ artist: 6, album: 4 });
  expect(next.audioFeatures).toEqual(
    DEFAULT_SMART_SHUFFLE_CONFIG.audioFeatures,
  );
});

test("拖动滑杆会更新对应字段", () => {
  const { onChange } = renderPanel();
  const sliders = screen.getAllByRole("slider");
  fireEvent.change(sliders[0], { target: { value: "90" } });
  const next = onChange.mock.calls[0]?.[0];
  expect(next.experience.randomness).toBe(90);
  expect(next.experience.diversity).toBe(50);
});

test("复制配置 JSON 不包含预留字段", async () => {
  const writeText = vi.fn(async (_text: string) => {});
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  const { onNotice } = renderPanel();
  fireEvent.click(screen.getByRole("button", { name: "复制配置 JSON" }));
  await waitFor(() => expect(writeText).toHaveBeenCalledTimes(1));
  const text = writeText.mock.calls[0]?.[0] as string;
  expect(JSON.parse(text)).toEqual({
    version: 1,
    experience: { randomness: 60, diversity: 50, repeatAvoidance: 80 },
    separation: { artist: 3, album: 2 },
  });
  expect(text).not.toContain("audioFeatures");
  expect(onNotice).toHaveBeenCalledWith("已复制配置");
});
