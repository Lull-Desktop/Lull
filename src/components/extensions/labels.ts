/** 扩展中心共用的文案映射：能力、状态、类型。 */

export type CapabilityLevel = "强制" | "提示" | "基础";

export const CAPABILITY_META: Record<
  string,
  { label: string; level: CapabilityLevel }
> = {
  "widget.ui": { label: "界面", level: "基础" },
  "widget.theme": { label: "主题", level: "提示" },
  "widget.state": { label: "状态存储", level: "强制" },
  "widget.audio": { label: "音频", level: "提示" },
  "widget.media": { label: "媒体选择", level: "提示" },
  "widget.network": { label: "网络", level: "强制" },
  "widget.chrome": { label: "窗口控制", level: "强制" },
  "wallpaper.viewport": { label: "壁纸视口", level: "基础" },
  "wallpaper.canvas": { label: "共享画布", level: "基础" },
  "wallpaper.sync": { label: "跨屏同步", level: "基础" },
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_META[capability]?.label ?? capability;
}

export function capabilityLevel(capability: string): CapabilityLevel {
  return CAPABILITY_META[capability]?.level ?? "基础";
}

export function kindLabel(kind: string): string {
  return kind === "widget" ? "工具" : "壁纸";
}

export function statusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "已校验";
    case "unverified":
      return "未校验";
    case "tampered":
      return "摘要不符";
    case "invalid":
      return "清单无效";
    case "needs-review":
      return "待复核";
    default:
      return status;
  }
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const kib = bytes / 1024;
  if (kib < 1024) return `${kib.toFixed(1)} KiB`;
  return `${(kib / 1024).toFixed(1)} MiB`;
}
