/**
 * Lull Scene Host 线上协议 v1。
 *
 * 与宿主 `src/scenes/scene-bridge.ts` 逐字段对应；改字段必须同时改宿主与
 * `client.test.ts` 的契约断言，否则已发布的场景包会静默失效。
 */
export declare const SCENE_PROTOCOL: 1;
export type SceneParamValue = string | number | boolean;
export type SceneRect = {
    x: number;
    y: number;
    w: number;
    h: number;
};
export type SceneDisplayMode = "mirror" | "independent" | "span";
export type SceneLayout = "viewport" | "canvas";
export type SceneViewport = {
    w: number;
    h: number;
    dpr: number;
};
export type SceneSync = {
    enabled: boolean;
    epochMs: number;
};
export type ScenePerformanceHints = {
    tier: "low" | "medium" | "high";
    targetFps?: number;
};
/**
 * 宿主下发的鼠标位置样本。
 *
 * 与宿主 `src/sdk/scene/types.ts` 的 `ScenePointer` 逐字段对应。
 * 只包含移动状态与坐标：没有按键、点击次数、滚轮或修饰键字段。
 * `x`/`y` 是场景绘制坐标系内的 CSS 像素：
 * - `layout === "viewport"`：本屏 iframe 的左上角为原点；
 * - `layout === "canvas"`：共享画布的左上角为原点。
 */
export type ScenePointer = {
    x: number;
    y: number;
    /** 光标位于桌面层，且落在本场景绘制面内。 */
    inside: boolean;
    /** 最近约 120ms 内是否观察到移动；静止、移出桌面或壁纸隐藏时为 false。 */
    moving: boolean;
};
/** 宿主每帧/每次参数变化下发的只读画面信息。 */
export type SceneFrame = {
    mode: SceneDisplayMode;
    layout: SceneLayout;
    sync: SceneSync;
    viewport: SceneViewport;
    canvas: SceneRect | null;
    view: SceneRect | null;
    dpr: number;
    params: Record<string, SceneParamValue>;
    reducedMotion: boolean;
    performance: ScenePerformanceHints | null;
};
export type SceneInitMessage = {
    v: typeof SCENE_PROTOCOL;
    type: "init";
    protocol: typeof SCENE_PROTOCOL;
    hostApi: number;
    id: string;
    frame: SceneFrame;
    visible: boolean;
};
export type SceneFrameMessage = {
    v: typeof SCENE_PROTOCOL;
    type: "frame";
    frame: SceneFrame;
};
export type SceneVisibilityMessage = {
    v: typeof SCENE_PROTOCOL;
    type: "visibility";
    visible: boolean;
};
export type ScenePointerMessage = {
    v: typeof SCENE_PROTOCOL;
    type: "pointer";
    pointer: ScenePointer;
};
export type SceneHostMessage = SceneInitMessage | SceneFrameMessage | SceneVisibilityMessage | ScenePointerMessage;
export type SceneReadyMessage = {
    v: typeof SCENE_PROTOCOL;
    type: "ready";
    protocol: typeof SCENE_PROTOCOL;
};
export type SceneLogMessage = {
    v: typeof SCENE_PROTOCOL;
    type: "log";
    level: "log" | "warn" | "error";
    message: string;
};
export type SceneClientMessage = SceneReadyMessage | SceneLogMessage;
/** 只做协议层校验；未知字段忽略，方便宿主向前兼容地追加信息。 */
export declare function isScenePointer(value: unknown): value is ScenePointer;
/** 只做协议层校验；未知字段忽略，方便宿主向前兼容地追加信息。 */
export declare function isSceneFrame(value: unknown): value is SceneFrame;
export declare function isSceneHostMessage(value: unknown): value is SceneHostMessage;
//# sourceMappingURL=protocol.d.ts.map