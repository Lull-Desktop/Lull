/** 扩展中心共用的文案映射：能力、状态、类型。全部走消息表，随界面语言变化。 */
import { m } from "@/paraglide/messages";

/** 能力等级：由宿主强制拦截 / 仅提示 / 基础能力。 */
export type CapabilityLevel = "required" | "hint" | "basic";

const CAPABILITY_META: Record<
  string,
  { label: () => string; level: CapabilityLevel }
> = {
  "widget.ui": { label: m.ext_cap_ui, level: "basic" },
  "widget.theme": { label: m.ext_cap_theme, level: "hint" },
  "widget.state": { label: m.ext_cap_state, level: "required" },
  "widget.audio": { label: m.ext_cap_audio, level: "hint" },
  "widget.media": { label: m.ext_cap_media, level: "hint" },
  "widget.network": { label: m.ext_cap_network, level: "required" },
  "widget.chrome": { label: m.ext_cap_chrome, level: "required" },
  "wallpaper.viewport": { label: m.ext_cap_viewport, level: "basic" },
  "wallpaper.canvas": { label: m.ext_cap_canvas, level: "basic" },
  "wallpaper.sync": { label: m.ext_cap_sync, level: "basic" },
};

export function capabilityLabel(capability: string): string {
  return CAPABILITY_META[capability]?.label() ?? capability;
}

export function capabilityLevelName(capability: string): CapabilityLevel {
  return CAPABILITY_META[capability]?.level ?? "basic";
}

/** 等级的展示文案。等级本身是机器值，翻译在渲染时做。 */
export function capabilityLevel(capability: string): string {
  switch (capabilityLevelName(capability)) {
    case "required":
      return m.ext_level_required();
    case "hint":
      return m.ext_level_hint();
    default:
      return m.ext_level_basic();
  }
}

export function kindLabel(kind: string): string {
  return kind === "widget" ? m.ext_kind_widget() : m.ext_kind_scene();
}

export function statusLabel(status: string): string {
  switch (status) {
    case "ready":
      return m.ext_status_ready();
    case "unverified":
      return m.ext_status_unverified();
    case "tampered":
      return m.ext_status_tampered();
    case "invalid":
      return m.ext_status_invalid();
    case "needs-review":
      return m.ext_status_needs_review();
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
