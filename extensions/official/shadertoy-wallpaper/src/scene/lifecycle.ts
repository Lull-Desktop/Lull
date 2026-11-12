/**
 * 场景生命周期里的纯逻辑（便于单测）：参数还原与暂停判定。
 */
import type { SceneParamValue } from "@lull/scene-sdk";

export type RuntimeParams = {
  source: string;
  renderScale: number;
  animation: boolean;
};

/** 宿主已按 Manifest 类型还原参数；这里只做防御性兜底。 */
export function readRuntimeParams(
  params: Readonly<Record<string, SceneParamValue>>,
): RuntimeParams {
  const source = typeof params.source === "string" ? params.source : "";
  const scale = params["render-scale"];
  return {
    source,
    renderScale:
      typeof scale === "number" && Number.isFinite(scale) ? scale : 1,
    animation: params.animation !== false,
  };
}

/**
 * 解析实际要编译的源码：空源码（宿主从未下发，或用户点了「恢复默认」）回退到
 * `fallback`（内置示例），否则原样返回用户源码 —— 不改写、不裁剪，行号偏移提示
 * 依赖源码原文。
 */
export function resolveSource(source: string, fallback: string): string {
  return source.trim() === "" ? fallback : source;
}

export type PauseInput = {
  animation: boolean;
  /** 宿主下发的窗口可见性（关闭/隐藏时为 false）。 */
  visible: boolean;
  /** 文档可见性（壁纸窗被最小化/切走）。 */
  documentVisible: boolean;
  hasProgram: boolean;
  /** 性能护栏已停止渲染。 */
  stopped?: boolean;
};

/** 暂停条件：不渲染时同时冻结 iTime，恢复后不产生时间跳跃。 */
export function shouldPause(input: PauseInput): boolean {
  return (
    !input.animation ||
    !input.visible ||
    !input.documentVisible ||
    !input.hasProgram ||
    input.stopped === true
  );
}
