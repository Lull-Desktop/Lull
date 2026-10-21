/**
 * 液态番茄钟页测试：默认时长、开始/暂停、外圈滑杆调时长与完成后的阶段轮转。
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import { FLOW_THEME_STORAGE_KEY } from "@/lib/flow-theme";
import PomodoroPage from "./page";

beforeEach(() => {
  window.localStorage.clear();
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

test("默认显示 25:00，开始后按绝对时间倒计时", async () => {
  vi.useFakeTimers();
  render(<PomodoroPage />);

  expect(screen.getByRole("button", { name: /开始专注，25:00/ })).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "开始专注" }));
  expect(screen.getByRole("button", { name: "暂停" })).toBeDefined();

  await act(async () => {
    vi.advanceTimersByTime(60_000);
  });
  expect(screen.getByRole("button", { name: /暂停，24:00/ })).toBeDefined();
});

test("拖动外圈 / 滚轮调节专注时长，数字与滑杆同步", () => {
  render(<PomodoroPage />);
  const ring = screen.getByRole("slider", { name: "专注时长" });
  expect(ring.getAttribute("aria-valuenow")).toBe("25");

  fireEvent.wheel(ring, { deltaY: -100 });
  expect(ring.getAttribute("aria-valuenow")).toBe("26");
  expect(screen.getByRole("button", { name: /开始专注，26:00/ })).toBeDefined();

  fireEvent.keyDown(ring, { key: "Home" });
  expect(ring.getAttribute("aria-valuenow")).toBe("5");
  expect(screen.getByRole("button", { name: /开始专注，05:00/ })).toBeDefined();
});

test("沿外圈拖动指针可以连续调整时长", () => {
  render(<PomodoroPage />);
  const ring = screen.getByRole("slider", { name: "专注时长" });
  const rect = {
    left: 0,
    top: 0,
    width: 200,
    height: 200,
    right: 200,
    bottom: 200,
    x: 0,
    y: 0,
    toJSON: () => ({}),
  } as DOMRect;
  Object.defineProperty(ring, "getBoundingClientRect", {
    value: () => rect,
  });

  // 3 点方向 = 15 分；6 点方向 = 30 分。
  fireEvent.pointerDown(ring, {
    pointerId: 1,
    button: 0,
    clientX: 200,
    clientY: 100,
  });
  expect(ring.getAttribute("aria-valuenow")).toBe("15");
  fireEvent.pointerMove(ring, {
    pointerId: 1,
    clientX: 100,
    clientY: 200,
  });
  expect(ring.getAttribute("aria-valuenow")).toBe("30");
  fireEvent.pointerUp(ring, {
    pointerId: 1,
    clientX: 100,
    clientY: 200,
  });
  expect(screen.getByRole("button", { name: /开始专注，30:00/ })).toBeDefined();
});

test("右侧卡片可直接切换专注 / 休息", () => {
  render(<PomodoroPage />);
  const breakCard = screen.getByRole("button", { name: /^休息，05:00/ });
  fireEvent.click(breakCard);
  expect(breakCard.getAttribute("aria-pressed")).toBe("true");
  expect(screen.getByRole("button", { name: "开始休息" })).toBeDefined();
  expect(screen.getByRole("button", { name: /开始休息，05:00/ })).toBeDefined();
});

test("底部设置锚点打开计时设置，可调整休息时长与自动开始", () => {
  render(<PomodoroPage />);
  fireEvent.click(screen.getByRole("button", { name: "打开计时设置" }));
  expect(screen.getByRole("dialog", { name: "计时设置" })).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "增加短休时长" }));
  expect(screen.getByText("6 分")).toBeDefined();

  const autoStart = screen.getByRole("switch", { name: "自动开始下一轮" });
  expect(autoStart.getAttribute("aria-checked")).toBe("false");
  fireEvent.click(autoStart);
  expect(autoStart.getAttribute("aria-checked")).toBe("true");
});

test("专注结束后先播放四拍仪式，再切换到 05:00 短休并点亮第一颗珍珠", async () => {
  vi.useFakeTimers();
  // 液面由 rAF 连续驱动；测试里不需要逐帧，避免快进 5 分钟时跑上万帧。
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => {});
  render(<PomodoroPage />);

  const ring = screen.getByRole("slider", { name: "专注时长" });
  fireEvent.keyDown(ring, { key: "Home" });
  fireEvent.click(screen.getByRole("button", { name: "开始专注" }));

  await act(async () => {
    vi.advanceTimersByTime(5 * 60_000);
  });
  // 0.5s 脉冲 / 1.2s 涟漪 / 2.0s 蜕变：阶段与数字已经切到短休，但仪式尚未收尾。
  await act(async () => {
    vi.advanceTimersByTime(2_100);
  });
  expect(
    screen
      .getByRole("button", { name: /^休息，05:00/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen.getByRole("img", { name: "本轮已完成 1 个番茄，共 4 个" }),
  ).toBeDefined();

  // 3.2s 仪式收尾后才恢复「开始休息」按钮。
  await act(async () => {
    vi.advanceTimersByTime(1_200);
  });
  expect(screen.getByRole("button", { name: "开始休息" })).toBeDefined();
});

test("面板样式跟随全局主题流光", async () => {
  window.localStorage.setItem(FLOW_THEME_STORAGE_KEY, "violet");
  const { container } = render(<PomodoroPage />);

  await waitFor(() => {
    expect(container.querySelector('[data-theme="violet"]')).not.toBeNull();
  });
  expect(document.documentElement.dataset.flowTheme).toBe("violet");
});
