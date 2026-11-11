/**
 * 全屏渲染用的固定模板：顶点着色器、uniform 声明与 GLSL ES 1.00 兼容宏。
 *
 * 适配原则（RFC §7.1）：注入 Shadertoy Image Profile 需要的最小集合。外部通道
 * 没有真实来源，由运行时绑定占位纹理（iChannel0 噪声，iChannel1-3 黑色）。
 */

export const VERTEX_SHADER_SOURCE = [
  "attribute vec2 aPosition;",
  "varying vec2 vUv;",
  "varying vec2 uv;",
  "varying vec2 vTexCoord;",
  "void main() {",
  "  vec2 coord = aPosition * 0.5 + 0.5;",
  "  vUv = coord;",
  "  uv = coord;",
  "  vTexCoord = coord;",
  "  gl_Position = vec4(aPosition, 0.0, 1.0);",
  "}",
].join("\n");

/** Shadertoy Image Profile 支持的全部 uniform（占位通道见 channel-textures）。 */
export const UNIFORM_DECLARATIONS = [
  "uniform vec3  iResolution;",
  "uniform float iTime;",
  "uniform float iTimeDelta;",
  "uniform float iFrameRate;",
  "uniform int   iFrame;",
  "uniform vec4  iMouse;",
  "uniform vec4  iDate;",
  "uniform sampler2D iChannel0;",
  "uniform sampler2D iChannel1;",
  "uniform sampler2D iChannel2;",
  "uniform sampler2D iChannel3;",
  "uniform vec3  iChannelResolution[4];",
  "uniform float iChannelTime[4];",
  "uniform float iSampleRate;",
] as const;

export const UNIFORM_NAMES = [
  "iResolution",
  "iTime",
  "iTimeDelta",
  "iFrameRate",
  "iFrame",
  "iMouse",
  "iDate",
  "iChannel0",
  "iChannel1",
  "iChannel2",
  "iChannel3",
  "iSampleRate",
] as const;

export type UniformName = (typeof UNIFORM_NAMES)[number];

/** 由模板负责声明的 uniform；用户源码里重复声明会被剥掉，避免 redefinition。 */
export const OWNED_UNIFORM_NAMES: ReadonlySet<string> = new Set([
  ...UNIFORM_NAMES,
  "iChannelResolution",
  "iChannelTime",
]);

/**
 * GLSL ES 1.00 兼容宏。
 *
 * Shadertoy 的源码普遍使用 `texture()`；WebGL1 的 ES 1.00 只有 `texture2D()`。
 * `textureLod` / `textureGrad` 在 ES 1.00 下退化为普通采样（没有 mipmap LOD）。
 */
export const COMPATIBILITY_MACROS = [
  "#define HW_PERFORMANCE 1",
  "#ifndef texture",
  "#define texture texture2D",
  "#endif",
  "#ifndef textureLod",
  "#define textureLod(s, uv, lod) texture2D(s, uv)",
  "#endif",
  "#ifndef textureGrad",
  "#define textureGrad(s, uv, dx, dy) texture2D(s, uv)",
  "#endif",
] as const;
