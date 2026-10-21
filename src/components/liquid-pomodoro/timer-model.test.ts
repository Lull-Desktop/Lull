/**
 * 计时模型测试：阶段轮转、珍珠状态与圆盘刻度换算。
 */
import { expect, test } from "vitest";
import {
  advancePhase,
  beadStates,
  clampFocusMinutes,
  dialAngleAt,
  dialAngleForMinutes,
  formatClock,
  liquidFillPercent,
  minutesForDialAngle,
  phaseForCard,
} from "./timer-model";

test("时钟格式向上取整并补零", () => {
  expect(formatClock(1500)).toBe("25:00");
  expect(formatClock(1499.2)).toBe("25:00");
  expect(formatClock(59.1)).toBe("01:00");
  expect(formatClock(-3)).toBe("00:00");
});

test("专注时长收在 5–60 分钟", () => {
  expect(clampFocusMinutes(1)).toBe(5);
  expect(clampFocusMinutes(25.4)).toBe(25);
  expect(clampFocusMinutes(90)).toBe(60);
  expect(clampFocusMinutes(Number.NaN)).toBe(25);
});

test("专注结束进入短休，第 4 次后进入长休，长休结束清空周期", () => {
  expect(advancePhase("focus", 0)).toEqual({
    phase: "shortBreak",
    completedFocus: 1,
  });
  expect(advancePhase("focus", 2)).toEqual({
    phase: "shortBreak",
    completedFocus: 3,
  });
  expect(advancePhase("focus", 3)).toEqual({
    phase: "longBreak",
    completedFocus: 4,
  });
  expect(advancePhase("shortBreak", 2)).toEqual({
    phase: "focus",
    completedFocus: 2,
  });
  expect(advancePhase("longBreak", 4)).toEqual({
    phase: "focus",
    completedFocus: 0,
  });
});

test("完成 4 轮后休息卡指向长休", () => {
  expect(phaseForCard("break", 0)).toBe("shortBreak");
  expect(phaseForCard("break", 3)).toBe("shortBreak");
  expect(phaseForCard("break", 4)).toBe("longBreak");
});

test("圆盘角度与分钟双向换算，整圈对应 60 分钟", () => {
  expect(minutesForDialAngle(0)).toBe(5);
  expect(minutesForDialAngle(90)).toBe(15);
  expect(minutesForDialAngle(150)).toBe(25);
  expect(minutesForDialAngle(354)).toBe(59);
  expect(dialAngleForMinutes(25)).toBe(150);
  expect(dialAngleForMinutes(5)).toBe(30);
  expect(dialAngleForMinutes(60)).toBe(360);
});

test("指针角度以 12 点为 0°、顺时针增大", () => {
  expect(dialAngleAt(0, 0, 0, -10)).toBeCloseTo(360);
  expect(dialAngleAt(0, 0, 10, 0)).toBeCloseTo(450);
  expect(minutesForDialAngle(dialAngleAt(0, 0, 0, -10))).toBe(5);
  expect(minutesForDialAngle(dialAngleAt(0, 0, 10, 0))).toBe(15);
});

test("液面随剩余时间下降，满格保留顶部空腔", () => {
  expect(liquidFillPercent(1500, 1500)).toBe(64);
  expect(liquidFillPercent(750, 1500)).toBe(32);
  expect(liquidFillPercent(0, 1500)).toBe(0);
  expect(liquidFillPercent(10, 0)).toBe(0);
});

test("珍珠状态跟随完成数与专注进度", () => {
  expect(beadStates(2, "focus", 0.4)).toEqual([
    "full",
    "full",
    "charging",
    "empty",
  ]);
  expect(beadStates(2, "shortBreak", 0.4)).toEqual([
    "full",
    "full",
    "empty",
    "empty",
  ]);
  expect(beadStates(4, "longBreak", 0)).toEqual([
    "full",
    "full",
    "full",
    "full",
  ]);
  expect(beadStates(0, "focus", 0)).toEqual([
    "empty",
    "empty",
    "empty",
    "empty",
  ]);
});
