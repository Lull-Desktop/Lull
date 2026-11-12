/**
 * 音境组件的接线与手势回归：
 * - 齿轮必须把设置窗口唤起到「音境」页签，而不再展开窗内二级菜单；
 * - 交互护栏要吃掉框选 / 拖拽 / 右键，但不能吃掉泡泡开关与音量手势。
 */
import { LullProvider } from "@lull/widget-sdk/react";
import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, test, vi } from "vitest";

/** 点齿轮时真正发出的桥调用；用 hoisted 保证 mock 工厂能引用。 */
const openSettings = vi.hoisted(() => vi.fn(() => Promise.resolve()));

vi.mock("./compat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compat")>();
  return { ...actual, widgetOpenSettings: openSettings };
});

const { createDemoWidgetClient } = await import("./compat");
const { EtherBubbles } = await import("./ether-bubbles");

function mountRoot(): { root: HTMLElement; outside: HTMLElement } {
  const { container } = render(
    <LullProvider client={createDemoWidgetClient()}>
      <EtherBubbles />
    </LullProvider>,
  );
  const root = container.querySelector<HTMLElement>(".ether-bubbles-root");
  if (!root) throw new Error("缺少音境根节点");
  const outside = document.createElement("p");
  outside.textContent = "页面其他区域";
  document.body.append(outside);
  return { root, outside };
}

/** jsdom 没有完整的 MouseEvent，用例只关心默认行为与冒泡路径。 */
function fire(target: EventTarget, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function bubbleButtons(): HTMLElement[] {
  return screen.getAllByRole("button", { name: /点击(开启|关闭)/ });
}

afterEach(() => {
  openSettings.mockClear();
  document.body.innerHTML = "";
});

test("根节点挡住框选、拖拽与右键菜单", () => {
  const { root, outside } = mountRoot();
  const title = screen.getByText("音境");
  expect(root.contains(title)).toBe(true);
  expect(fire(title, "selectstart").defaultPrevented).toBe(true);
  expect(fire(title, "dragstart").defaultPrevented).toBe(true);
  expect(fire(title, "contextmenu").defaultPrevented).toBe(true);

  const gear = screen.getByRole("button", { name: "声场设置" });
  expect(root.contains(gear)).toBe(true);
  expect(fire(gear, "contextmenu").defaultPrevented).toBe(true);

  // 模块之外的同页节点不受影响。
  expect(fire(outside, "contextmenu").defaultPrevented).toBe(false);
  expect(fire(outside, "selectstart").defaultPrevented).toBe(false);
});

test("齿轮把设置窗口唤到音境页签，窗内不再展开二级菜单", () => {
  mountRoot();
  const gear = screen.getByRole("button", { name: "声场设置" });
  expect(gear.getAttribute("aria-expanded")).toBeNull();

  fireEvent.click(gear);
  expect(openSettings).toHaveBeenCalledTimes(1);
  expect(openSettings).toHaveBeenLastCalledWith("noise");
  // 旧的面板（dialog / 预设下拉）不再出现。
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(screen.queryByRole("combobox")).toBeNull();
});

test("设置窗口关掉后再点齿轮，仍然重新请求同一页签", () => {
  mountRoot();
  const gear = screen.getByRole("button", { name: "声场设置" });
  fireEvent.click(gear);
  // 宿主侧关掉窗口后（可见性事件不在组件里维护），再点一次必须再发一次请求。
  fireEvent.click(gear);
  expect(openSettings).toHaveBeenCalledTimes(2);
  expect(openSettings.mock.calls).toEqual([["noise"], ["noise"]]);
});

test("泡泡的点击开关、滚轮与拖动调节不受护栏影响", () => {
  mountRoot();
  const bubble = bubbleButtons()[0];
  if (!bubble) throw new Error("缺少音轨泡泡");
  const pressed = bubble.getAttribute("aria-pressed");
  fireEvent.click(bubble);
  expect(bubble.getAttribute("aria-pressed")).not.toBe(pressed);

  const beforeWheel = bubble.getAttribute("aria-label");
  fireEvent.wheel(bubble, { deltaY: -100 });
  expect(bubble.getAttribute("aria-label")).not.toBe(beforeWheel);

  const beforeDrag = bubble.getAttribute("aria-label");
  fireEvent.pointerDown(bubble, { button: 0, pointerId: 1, clientY: 200 });
  fireEvent.pointerMove(bubble, { pointerId: 1, clientY: 140 });
  fireEvent.pointerUp(bubble, { pointerId: 1, clientY: 140 });
  expect(bubble.getAttribute("aria-label")).not.toBe(beforeDrag);
});
