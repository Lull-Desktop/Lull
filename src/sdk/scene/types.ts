/**
 * 场景 SDK 的运行时类型：场景组件只接收宿主提供的只读画面信息。
 *
 * 约定：
 * - 场景不得直接调用 Tauri IPC；
 * - 场景只读取 `frame`，不读写宿主配置；
 * - 跨屏场景按 `layout === "canvas"` 在共享画布坐标系内绘制。
 */
import type { ReactNode } from "react";
import type { Rect } from "@/core/wallpaper/params";
import type { SceneManifest } from "./manifest";

export type SceneLayout = "viewport" | "canvas";

export type SceneFrame = {
  /** viewport = 每屏独立视口；canvas = 跨屏共享画布。 */
  layout: SceneLayout;
  /** 动画是否按绝对时间对齐相位。 */
  sync: boolean;
  /** 共享画布矩形（物理像素桌面坐标，可为负）；viewport 布局为 null。 */
  canvas: Rect | null;
  /** 当前窗口对应的桌面矩形（物理像素）。 */
  view: Rect | null;
  /** 当前窗口的 devicePixelRatio。 */
  dpr: number;
};

export type SceneProps = SceneFrame;

export type SceneComponent = (props: SceneProps) => ReactNode;

/** 源码内置场景：由注册表直接挂载，不经过 iframe。 */
export type BuiltinScene = {
  readonly source: "builtin";
  readonly manifest: SceneManifest;
  readonly component: SceneComponent;
};

/** 设置页 / 场景宿主共用的目录条目。 */
export type SceneCatalogEntry = {
  readonly manifest: SceneManifest;
  readonly source: "builtin" | "content";
  /** 外部静态内容包的入口 URL；内置场景为 null。 */
  readonly entryUrl: string | null;
  /** 内置场景的组件；外部场景为 null。 */
  readonly component: SceneComponent | null;
};
