import { SCENE_PROTOCOL, type SceneFrame, type SceneParamValue, type ScenePointer } from "./protocol.js";
import { type SceneTransport } from "./transport.js";
export type LullSceneClient = {
    /** 场景 id（来自 Manifest）。 */
    readonly id: string;
    /** 宿主 Scene Host API 版本。 */
    readonly hostApi: number;
    /** 桥协议版本，固定为 1。 */
    readonly protocol: typeof SCENE_PROTOCOL;
    /** 最近一帧；init 之前为 null。 */
    readonly frame: SceneFrame | null;
    /** 当前参数（已按 Manifest 类型还原）；init 之前为空对象。 */
    readonly params: Record<string, SceneParamValue>;
    /** 当前窗口是否可见（关闭/隐藏时由宿主下发）。 */
    readonly visible: boolean;
    /** 最近一次鼠标位置样本；init 之后、首个样本之前为 null。 */
    readonly pointer: ScenePointer | null;
    /** 订阅帧更新；注册时立即回放当前帧。 */
    onFrame(listener: (frame: SceneFrame) => void): () => void;
    /** 只订阅参数变化；注册时立即回放当前参数。 */
    onParams(listener: (params: Record<string, SceneParamValue>) => void): () => void;
    /** 订阅窗口可见性；注册时立即回放当前值。 */
    onVisibility(listener: (visible: boolean) => void): () => void;
    /** 订阅鼠标位置（只含移动状态与坐标）；注册时回放当前值。 */
    onPointer(listener: (pointer: ScenePointer) => void): () => void;
    /** 转发到宿主控制台，前缀 `[scene:<id>]`。 */
    log(message: string, level?: "log" | "warn" | "error"): void;
    /** 退订全部监听并拒绝后续调用。 */
    destroy(): void;
};
export type ConnectLullSceneOptions = {
    /** 替换传输层；测试用 `@lull/scene-sdk/testing` 的内存实现。 */
    transport?: SceneTransport;
    /** 等待宿主 init 的超时；默认 10s。 */
    timeoutMs?: number;
};
export declare function connectLullScene(options?: ConnectLullSceneOptions): Promise<LullSceneClient>;
/**
 * 创建一个独立连接（不走单例）。测试与多场景页面可以直接使用；
 * 普通场景页面用 `connectLullScene()` 即可。
 */
export declare function createLullSceneClient(options?: ConnectLullSceneOptions): Promise<LullSceneClient>;
//# sourceMappingURL=client.d.ts.map