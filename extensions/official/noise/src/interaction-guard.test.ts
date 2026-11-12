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

/** 音境根节点（模块内）与同级节点（模拟页面其他区域）各一份。 */
function mount(): void {
  const outside = document.createElement("div");
  outside.className = "host-shell";
  outside.innerHTML = '<p id="host-copy">页面其他区域</p>';

  const root = document.createElement("div");
  root.className = "ether-bubbles-root";
  root.innerHTML = [
    '<span id="glyph">雨</span>',
    '<span id="readout">42%</span>',
    '<img id="icon" alt="" />',
    '<button id="bubble" type="button">雨声</button>',
    '<select id="preset"><option>雨夜</option></select>',
    '<input id="name" />',
    '<input id="range" type="range" />',
  ].join("");

  document.body.append(outside, root);
  teardown = installInteractionGuard(root);
}

test("取消模块内的右键菜单", () => {
  mount();
  expect(fire(byId("glyph"), "contextmenu").defaultPrevented).toBe(true);
  expect(fire(byId("bubble"), "contextmenu").defaultPrevented).toBe(true);
  expect(fire(byId("preset"), "contextmenu").defaultPrevented).toBe(true);
});

test("不干扰模块之外的右键菜单", () => {
  mount();
  expect(fire(byId("host-copy"), "contextmenu").defaultPrevented).toBe(false);
});

test("禁止图片与元素被原生拖拽", () => {
  mount();
  expect(fire(byId("icon"), "dragstart").defaultPrevented).toBe(true);
  expect(fire(byId("glyph"), "dragstart").defaultPrevented).toBe(true);
  expect(fire(byId("readout"), "dragstart").defaultPrevented).toBe(true);
});

test("不干扰模块之外的拖拽", () => {
  mount();
  expect(fire(byId("host-copy"), "dragstart").defaultPrevented).toBe(false);
});

test("禁止框选文字与元素，但保留输入框的原生选区", () => {
  mount();
  expect(fire(byId("glyph"), "selectstart").defaultPrevented).toBe(true);
  expect(fire(byId("readout"), "selectstart").defaultPrevented).toBe(true);
  expect(fire(byId("range"), "selectstart").defaultPrevented).toBe(true);
  expect(fire(byId("name"), "selectstart").defaultPrevented).toBe(false);
});

test("不干扰模块之外的框选", () => {
  mount();
  expect(fire(byId("host-copy"), "selectstart").defaultPrevented).toBe(false);
});

test("isEditableTarget 只认读写文字的控件", () => {
  mount();
  expect(isEditableTarget(byId("name"))).toBe(true);
  expect(isEditableTarget(byId("range"))).toBe(false);
  expect(isEditableTarget(byId("preset"))).toBe(false);
  expect(isEditableTarget(byId("icon"))).toBe(false);
  expect(isEditableTarget(null)).toBe(false);
});

test("撤销后恢复原生行为", () => {
  mount();
  teardown?.();
  teardown = null;
  const glyph = byId("glyph");
  expect(fire(glyph, "contextmenu").defaultPrevented).toBe(false);
  expect(fire(glyph, "dragstart").defaultPrevented).toBe(false);
  expect(fire(glyph, "selectstart").defaultPrevented).toBe(false);
});
