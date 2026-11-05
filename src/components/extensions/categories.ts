/**
 * 扩展中心的分类筛选：工具 / 壁纸 / 游戏。
 *
 * 后端 `kind` 是机器值（widget/scene/game），`ExtensionCategory` 是产品分类；
 * 两者只在这里做一次映射，面板只依赖分类，不散落字符串比较。
 *
 * 托盘「扩展」子菜单的排除规则在 Rust 侧独立实现（见 `src-tauri/src/tray.rs`），
 * 不读取这里的筛选状态，两者互不干扰。
 */
import type { ExtensionInfo, ExtensionKind } from "@/lib/extensions";
import { m } from "@/paraglide/messages";

export type ExtensionCategory = "tool" | "wallpaper" | "game";
export type ExtensionFilter = "all" | ExtensionCategory;

/** 面板上的分类顺序：工具 → 壁纸 → 游戏。 */
export const EXTENSION_CATEGORIES: readonly ExtensionCategory[] = [
  "tool",
  "wallpaper",
  "game",
];

export type ExtensionCounts = Record<ExtensionFilter, number>;

/** 后端 kind → 产品分类；未知 kind 返回 null，避免新类型被误归到某个分类。 */
export function categoryOf(kind: string): ExtensionCategory | null {
  switch (kind) {
    case "widget":
      return "tool";
    case "scene":
      return "wallpaper";
    case "game":
      return "game";
    default:
      return null;
  }
}

/** 分类的筛选用展示名（复数：Tools / Wallpapers / Games）。 */
export function categoryLabel(category: ExtensionCategory): string {
  switch (category) {
    case "tool":
      return m.ext_filter_widget();
    case "wallpaper":
      return m.ext_filter_scene();
    case "game":
      return m.ext_filter_game();
  }
}

/** 打开分类目录时使用的后端 kind。 */
export function kindForCategory(category: ExtensionCategory): ExtensionKind {
  switch (category) {
    case "tool":
      return "widget";
    case "wallpaper":
      return "scene";
    case "game":
      return "game";
  }
}

/** 分类计数；`all` 是总数，未知 kind 只计入 `all`。 */
export function countExtensions(
  items: readonly ExtensionInfo[],
): ExtensionCounts {
  const counts: ExtensionCounts = {
    all: items.length,
    tool: 0,
    wallpaper: 0,
    game: 0,
  };
  for (const item of items) {
    const category = categoryOf(item.kind);
    if (category !== null) counts[category] += 1;
  }
  return counts;
}

/** 纯过滤：`all` 原样返回，其余按分类收窄。 */
export function filterExtensions(
  items: readonly ExtensionInfo[],
  filter: ExtensionFilter,
): readonly ExtensionInfo[] {
  if (filter === "all") return items;
  return items.filter((item) => categoryOf(item.kind) === filter);
}
