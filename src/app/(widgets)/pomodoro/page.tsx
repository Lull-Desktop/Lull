/**
 * 番茄钟窗口：以太之泡系列的液态时间沙漏。
 * 计时 / 阶段轮转 / 四拍仪式全部收敛在 LiquidPomodoro 组件里；这里只负责挂载。
 */
"use client";

import { LiquidPomodoro } from "@/components/liquid-pomodoro/liquid-pomodoro";

export default function PomodoroPage() {
  return <LiquidPomodoro />;
}
