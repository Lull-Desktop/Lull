/**
 * 扩展内部的源码模型（对应 RFC §5.4）。
 *
 * 这里不是 Package：不落盘、不参与内容库，只是「用户这次选择的文本内容」。
 * 源码文本由宿主通用 `text` 参数下发；文件读取在宿主设置面板完成。
 */

/** 源码长度上限；与宿主的 text 参数上限保持一致（`src/components/scene-params.tsx`）。 */
export const MAX_SOURCE_CHARS = 128 * 1024;

export const SUPPORTED_PROFILE = "shadertoy-image" as const;
export const RAW_FRAGMENT_PROFILE = "raw-fragment" as const;
export const VOLUME_PROFILE = "shadertoy-volume" as const;

/** 运行时需要的 GLSL 版本；WebGL2 才能编译 300 es。 */
export type GlslDialect = 100 | 300;

/**
 * Shadertoy Image（mainImage）、Volume（mainVolume，3D 纹理）或普通 fragment
 * shader（自定义 main）。
 */
export type ShaderProfile =
  | typeof SUPPORTED_PROFILE
  | typeof RAW_FRAGMENT_PROFILE
  | typeof VOLUME_PROFILE;

export type LoadedShaderSource = {
  /** 用户选择的文件名；只有宿主面板知道，场景里通常为 null。 */
  fileName: string | null;
  language: "glsl";
  profile: ShaderProfile;
  source: string;
  loadedAt: number;
};
