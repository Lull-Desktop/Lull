import { afterEach, expect, test } from "vitest";
import { installInteractionGuard, isEditableTarget } from "./interaction-guard";

/** jsdom 没有完整的 MouseEvent / DragEvent，用例只关心默认行为是否被取消。 */
function fire(target: EventTarget, type: string): Event {
  const event = new Event(type, { bubbles: true, cancelable: true });
  target.dispatchEvent(event);
  return event;
}

function byId(id: string): HTMLElement {
  const element = document.getElementById(id);
  if (!element) throw new Error(`缺少 #${id}`);
  return element;
}

let teardown: (() => void) | null = null;

afterEach(() => {
  teardown?.();
  teardown = null;
  document.body.innerHTML = "";
});

/** 根节点（播放器模块）与同级节点（模拟页面其他区域）各一份。 */
function mount(): void {
  const outside = document.createElement("div");
  outside.className = "host-shell";
  outside.innerHTML = '<p id="host-copy">页面其他区域</p>';

  const root = document.createElement("div");
  root.className = "liquid-player-root";
  root.innerHTML = [
    '<span id="label">曲目名</span>',
    '<img id="cover" alt="" />',
    '<input id="name" />',
    '<input id="range" type="range" />',
  ].join("");

  document.body.append(outside, root);
  teardown = installInteractionGuard(root);
}

test("取消模块内的右键菜单", () => {
  mount();
  expect(fire(byId("label"), "contextmenu").defaultPrevented).toBe(true);
  expect(fire(byId("cover"), "contextmenu").defaultPrevented).toBe(true);
});

test("不干扰模块之外的右键菜单", () => {
  mount();
  expect(fire(byId("host-copy"), "contextmenu").defaultPrevented).toBe(false);
});

test("禁止图片与元素被原生拖拽", () => {
  mount();
  expect(fire(byId("cover"), "dragstart").defaultPrevented).toBe(true);
  expect(fire(byId("label"), "dragstart").defaultPrevented).toBe(true);
});

test("禁止框选文字与元素，但保留输入框的原生选区", () => {
  mount();
  expect(fire(byId("label"), "selectstart").defaultPrevented).toBe(true);
  expect(fire(byId("range"), "selectstart").defaultPrevented).toBe(true);
  expect(fire(byId("name"), "selectstart").defaultPrevented).toBe(false);
});

test("isEditableTarget 只认读写文字的控件", () => {
  mount();
  expect(isEditableTarget(byId("name"))).toBe(true);
  expect(isEditableTarget(byId("range"))).toBe(false);
  expect(isEditableTarget(byId("cover"))).toBe(false);
  expect(isEditableTarget(null)).toBe(false);
});

test("撤销后恢复原生行为", () => {
  mount();
  teardown?.();
  teardown = null;
  const label = byId("label");
  expect(fire(label, "contextmenu").defaultPrevented).toBe(false);
  expect(fire(label, "dragstart").defaultPrevented).toBe(false);
  expect(fire(label, "selectstart").defaultPrevented).toBe(false);
});
