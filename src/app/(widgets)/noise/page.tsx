/**
 * 白噪音（EtherBubbles）：环境声工具窗入口。
 *
 * 页面使用沉浸式声景界面，不再套用纸色 Card 外壳；音频合成、泡泡交互和窗口贴合
 * 都封装在 src/components/ether-bubbles 下。工具窗仍由 Tauri 无边框窗口承载。
 */
"use client";

import { EtherBubbles } from "@/components/ether-bubbles/ether-bubbles";

export default function NoisePage() {
  return <EtherBubbles />;
}
