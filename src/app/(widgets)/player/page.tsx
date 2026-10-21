/**
 * 播放器窗口：液态黑胶播放器。
 * 音频解码、列表、进度拖拽与在线氛围合成全部收敛在 LiquidPlayer 组件里；
 * 这个路由只负责挂载，保持与其他工具窗一致的入口形态。
 */
"use client";

import { LiquidPlayer } from "@/components/liquid-player/liquid-player";

export default function PlayerPage() {
  return <LiquidPlayer />;
}
