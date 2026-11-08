/**
 * 桥协议中鼠标位置消息的契约：只接受移动状态与坐标，点击类消息一律丢弃。
 */
import { describe, expect, test } from "vitest";
import {
  isSceneHostMessage,
  isScenePointer,
  SCENE_PROTOCOL,
} from "./protocol.js";

const POINTER = { x: 120.5, y: 640, inside: true, moving: true };

describe("鼠标位置消息", () => {
  test("接受只含移动状态的 pointer", () => {
    expect(isScenePointer(POINTER)).toBe(true);
    expect(
      isSceneHostMessage({
        v: SCENE_PROTOCOL,
        type: "pointer",
        pointer: POINTER,
      }),
    ).toBe(true);
  });

  test("拒绝缺失字段 / 非有限坐标 / 非布尔的移动状态", () => {
    expect(isScenePointer(null)).toBe(false);
    expect(isScenePointer({ x: 1, y: 2, inside: true })).toBe(false);
    expect(
      isScenePointer({ x: Number.NaN, y: 2, inside: true, moving: true }),
    ).toBe(false);
    expect(isScenePointer({ x: 1, y: 2, inside: "yes", moving: true })).toBe(
      false,
    );
    expect(
      isSceneHostMessage({
        v: SCENE_PROTOCOL,
        type: "pointer",
        pointer: { x: 1, y: 2, inside: true },
      }),
    ).toBe(false);
  });

  test("点击、双击、按下、滚轮等类型全部拒绝", () => {
    for (const type of [
      "click",
      "dblclick",
      "mousedown",
      "mouseup",
      "pointerdown",
      "pointerup",
      "pointercancel",
      "contextmenu",
      "wheel",
    ]) {
      expect(isSceneHostMessage({ v: SCENE_PROTOCOL, type, x: 1, y: 2 })).toBe(
        false,
      );
    }
  });
});
