/**
 * 白噪音测试：声景控件渲染、点击开关、滚轮调音量、主泡静音与设置浮层。
 * Web Audio 在 jsdom 中不存在，所有手势都应安全降级为纯 UI 状态。
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, test } from "vitest";
import { FLOW_THEME_STORAGE_KEY } from "@/lib/flow-theme";
import NoisePage from "./page";

afterEach(() => {
  window.localStorage.clear();
});

test("渲染主泡与五种声景，并保留初始混音状态", () => {
  render(<NoisePage />);

  expect(screen.getByText("白噪音")).toBeDefined();
  for (const glyph of ["雨", "雷", "风", "浪", "火"]) {
    expect(screen.getByText(glyph)).toBeDefined();
  }

  expect(
    screen
      .getByRole("button", { name: /雨声，音量 70%/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(
    screen
      .getByRole("button", { name: /雷鸣，已关闭/ })
      .getAttribute("aria-pressed"),
  ).toBe("false");
  expect(
    screen
      .getByRole("button", { name: /篝火，音量 50%/ })
      .getAttribute("aria-pressed"),
  ).toBe("true");
  expect(screen.getByText(/70% · 润泽/)).toBeDefined();
});

test("点击泡泡切换开关，滚轮调整音量", () => {
  render(<NoisePage />);
  const rain = screen.getByRole("button", { name: /雨声/ });
  const fire = screen.getByRole("button", { name: /篝火/ });

  fireEvent.click(rain);
  expect(rain.getAttribute("aria-pressed")).toBe("false");
  expect(rain.getAttribute("aria-label")).toMatch(/已关闭/);

  fireEvent.click(rain);
  expect(rain.getAttribute("aria-pressed")).toBe("true");
  expect(rain.getAttribute("aria-label")).toMatch(/音量 70%/);

  fireEvent.wheel(fire, { deltaY: -100 });
  expect(fire.getAttribute("aria-label")).toMatch(/音量 54%/);

  fireEvent.wheel(fire, { deltaY: 100 });
  expect(fire.getAttribute("aria-label")).toMatch(/音量 50%/);
});

test("点击主泡静音，再次点击恢复", () => {
  render(<NoisePage />);
  const mother = screen.getByRole("button", { name: /白噪音/ });

  fireEvent.click(mother);
  expect(mother.getAttribute("aria-pressed")).toBe("true");
  expect(mother.getAttribute("aria-label")).toMatch(/已静音/);
  expect(screen.getByText(/75% · 静寂/)).toBeDefined();

  fireEvent.click(mother);
  expect(mother.getAttribute("aria-pressed")).toBe("false");
  expect(mother.getAttribute("aria-label")).not.toMatch(/已静音/);
});

test("齿轮打开更多设置：停靠侧、主题流光状态、定时器与自动隐去", async () => {
  // 主题流光已迁到设置窗口；气泡窗只消费全局值。这里预置「林光」，
  // 验证挂载后根节点跟着全局主题走，且设置面板不再出现本地色板。
  window.localStorage.setItem(FLOW_THEME_STORAGE_KEY, "jade");
  const { container } = render(<NoisePage />);
  await waitFor(() => {
    expect(container.querySelector('[data-theme="jade"]')).not.toBeNull();
  });

  const sideSwitch = screen.getByRole("button", {
    name: "屏幕位置改到左侧",
  });
  fireEvent.click(sideSwitch);
  expect(container.querySelector('[data-side="left"]')).not.toBeNull();
  expect(
    screen.getByRole("button", { name: "屏幕位置改到右侧" }),
  ).toBeDefined();

  fireEvent.click(screen.getByRole("button", { name: "泡泡设置" }));
  expect(screen.getByRole("dialog", { name: "泡泡设置" })).toBeDefined();
  expect(screen.queryByRole("button", { name: "左侧" })).toBeNull();

  expect(screen.queryByRole("button", { name: "主题流光：林光" })).toBeNull();
  expect(screen.getByText("林光 · 全局")).toBeDefined();

  const sleep = screen.getByRole("button", { name: /睡眠定时器，当前关闭/ });
  fireEvent.click(sleep);
  expect(
    screen.getByRole("button", { name: /睡眠定时器，当前15 分钟/ }),
  ).toBeDefined();

  const autoFade = screen.getByRole("switch", { name: "自动隐去" });
  expect(autoFade.getAttribute("aria-checked")).toBe("true");
  fireEvent.click(autoFade);
  expect(autoFade.getAttribute("aria-checked")).toBe("false");
});
