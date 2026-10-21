/**
 * 场景 SDK 的运行时类型：场景组件只接收宿主提供的只读画面信息。
 *
 * 约定：
 * - 场景不得直接调用 Tauri IPC；
 * - 场景只读取 `frame`，不读写宿主配置；
 * - 跨屏场景按 `layout === "canvas"` 在共享画布坐标系内绘制。
 */
import type { ReactNode } from "react";
import type { SceneManifest, ScenePerformanceHints } from "./manifest";
import type { SceneParamValue } from "./params";

/**
 * SDK 自有的矩形类型，避免 Apache-2.0 的 SDK 依赖 GPL 应用代码。
 * 与 `src/core/wallpaper/params.ts` 的 Rect 结构一致，宿主可直接传入。
 */
export type SceneRect = { x: number; y: number; w: number; h: number };

export type SceneLayout = "viewport" | "canvas";

/** 用户配置的显示模式；与 layout 正交。 */
export type SceneDisplayMode = "mirror" | "independent" | "span";

export type SceneViewport = {
  /** 当前 WebView 视口 CSS 像素宽。 */
  w: number;
  h: number;
  dpr: number;
};

export type SceneSync = {
  /** 宿主是否要求按绝对时间对齐相位。 */
  enabled: boolean;
  /** 宿主捕获的绝对时间锚点（毫秒）；enabled=false 时无意义。 */
  epochMs: number;
};

export type SceneFrame = {
  /** 用户配置的显示模式；场景可据此区分 mirror 与 independent。 */
  mode: SceneDisplayMode;
  /** viewport = 每屏独立视口；canvas = 跨屏共享画布。 */
  layout: SceneLayout;
  /** 动画是否按绝对时间对齐相位。 */
  sync: SceneSync;
  /** 当前 WebView 视口尺寸（CSS 像素）。 */
  viewport: SceneViewport;
  /** 共享画布矩形（物理像素桌面坐标，可为负）；仅 span 布局非 null。 */
  canvas: SceneRect | null;
  /** 当前窗口对应的桌面矩形（物理像素）。 */
  view: SceneRect | null;
  /** 当前窗口的 devicePixelRatio；与 viewport.dpr 相同，保留给既有场景。 */
  dpr: number;
  /** 按 Manifest 默认值解析后的场景参数。 */
  params: Readonly<Record<string, SceneParamValue>>;
  /** 用户是否要求减少动态效果。 */
  reducedMotion: boolean;
  /** Manifest 声明的性能提示；宿主未来可据此降级。 */
  performance: ScenePerformanceHints | null;
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
