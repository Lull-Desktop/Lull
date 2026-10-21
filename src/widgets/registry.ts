/**
 * 官方内置工具窗口注册表。
 *
 * 本文件是设置页 / 托盘文案的唯一来源；Rust 侧 `window_host::spec` 负责窗口
 * 的真实创建参数。两者通过 docs/widget-sdk.md 的字段表保持同步，新增工具时
 * 必须同时更新 `window_host::spec` 测试（Rust）与本表。
 */
import type { WidgetManifest } from "@/sdk/widget";

export const BUILTIN_WIDGETS: readonly WidgetManifest[] = [
  {
    schemaVersion: 1,
    type: "widget",
    id: "player",
    name: "播放器",
    version: "1.0.0",
    description: "液态黑胶播放器与在线氛围声。",
    author: "Lull",
    license: "MIT",
    capabilities: [
      "widget.ui",
      "widget.theme",
      "widget.state",
      "widget.audio",
      "widget.media",
    ],
    builtin: true,
    window: {
      label: "player",
      route: "player",
      title: "Lull 播放器",
      width: 880,
      height: 552,
      minWidth: 500,
      minHeight: 520,
      resizable: false,
      transparent: true,
    },
  },
  {
    schemaVersion: 1,
    type: "widget",
    id: "pomodoro",
    name: "番茄钟",
    version: "1.0.0",
    description: "液态时间沙漏，专注与休息的节奏。",
    author: "Lull",
    license: "MIT",
    capabilities: ["widget.ui", "widget.theme", "widget.state", "widget.audio"],
    builtin: true,
    window: {
      label: "pomodoro",
      route: "pomodoro",
      title: "Lull 番茄钟",
      width: 600,
      height: 690,
      minWidth: 560,
      minHeight: 640,
      resizable: false,
      transparent: true,
    },
  },
  {
    schemaVersion: 1,
    type: "widget",
    id: "noise",
    name: "白噪音",
    version: "1.0.0",
    description: "雨、风、海浪、篝火与远雷，可自由混音的五层声场。",
    author: "Lull",
    license: "MIT",
    capabilities: ["widget.ui", "widget.theme", "widget.state", "widget.audio"],
    builtin: true,
    window: {
      label: "noise",
      route: "noise",
      title: "Lull 白噪音",
      width: 600,
      height: 420,
      minWidth: 560,
      minHeight: 320,
      resizable: false,
      transparent: true,
    },
  },
];

export function widgetById(id: string): WidgetManifest | null {
  return BUILTIN_WIDGETS.find((widget) => widget.id === id) ?? null;
}
