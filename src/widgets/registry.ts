/**
 * 官方内置窗口注册表。
 *
 * 元数据的唯一事实源是 `src/widgets/manifests/*.json`：设置页 / 托盘从这里取
 * 展示名与顺序，Rust 在构建期读取同一批文件生成窗口描述（`window_host::spec`）。
 * 新增工具只需要加一份清单 + 一个路由页，不再手抄 Rust。
 */
import { m } from "@/paraglide/messages";
import { parseWidgetManifest, type WidgetManifest } from "@/sdk/widget";
import noiseManifest from "./manifests/noise.json" with { type: "json" };
import playerManifest from "./manifests/player.json" with { type: "json" };
import pomodoroManifest from "./manifests/pomodoro.json" with { type: "json" };
import settingsManifest from "./manifests/settings.json" with { type: "json" };

/** 所有由宿主管理的窗口（含设置外壳）。 */
export const WINDOW_MANIFESTS: readonly WidgetManifest[] = [
  settingsManifest,
  playerManifest,
  pomodoroManifest,
  noiseManifest,
].map((input, index) => parseWidgetManifest(input, `manifests[${index}]`));

/** 设置页 / 托盘消费的工具窗（不含设置外壳）。 */
export const BUILTIN_WIDGETS: readonly WidgetManifest[] =
  WINDOW_MANIFESTS.filter((widget) => widget.role === "tool").sort(
    (left, right) => (left.order ?? 100) - (right.order ?? 100),
  );

/**
 * 内置窗口的展示名与描述。
 *
 * 清单里的 `name` / `description` 是构建期元数据（Rust 也读同一份），
 * 界面展示走消息表：清单保持中文原文作为兜底，第三方窗口继续用它自己的元数据。
 */
const DISPLAY_NAME: Record<string, () => string> = {
  player: m.widget_player_name,
  pomodoro: m.widget_pomodoro_name,
  noise: m.widget_noise_name,
};

const DISPLAY_DESCRIPTION: Record<string, () => string> = {
  player: m.widget_player_description,
  pomodoro: m.widget_pomodoro_description,
  noise: m.widget_noise_description,
};

export function widgetDisplayName(widget: WidgetManifest): string {
  return DISPLAY_NAME[widget.id]?.() ?? widget.name;
}

export function widgetDisplayDescription(widget: WidgetManifest): string {
  return DISPLAY_DESCRIPTION[widget.id]?.() ?? widget.description ?? "";
}


export function widgetById(id: string): WidgetManifest | null {
  return BUILTIN_WIDGETS.find((widget) => widget.id === id) ?? null;
}
