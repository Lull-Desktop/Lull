/**
 * 全屏渲染用的固定模板：顶点着色器、uniform 声明与 GLSL ES 兼容宏。
 *
 * 适配原则（RFC §7.1）：注入 Shadertoy Image Profile 需要的最小集合。外部通道
 * 没有真实来源，由运行时绑定占位纹理（iChannel0 噪声，iChannel1-3 黑色）。
 *
 * ES 1.00 与 ES 3.00 共用 uniform 声明；顶点着色器与兼容宏按版本分开。
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

/** ES 3.00 顶点模板：`attribute/varying` 换成 `in/out`，输出名保持一致。 */
export const ES3_VERTEX_SHADER_SOURCE = [
  "#version 300 es",
  "in vec2 aPosition;",
  "out vec2 vUv;",
  "out vec2 uv;",
  "out vec2 vTexCoord;",
  "void main() {",
  "  vec2 coord = aPosition * 0.5 + 0.5;",
  "  vUv = coord;",
  "  uv = coord;",
  "  vTexCoord = coord;",
  "  gl_Position = vec4(aPosition, 0.0, 1.0);",
  "}",
].join("\n");

/** 通道纹理目标：2D 图像或 3D 体积纹理（Volume Pass，仅 ES 3.00）。 */
export type ChannelKind = "2d" | "3d";

/** 体积 Pass 逐 slice 渲染时由运行时设置的 slice 索引 uniform。 */
export const VOLUME_SLICE_UNIFORM = "uLullVolumeSlice";

const BASE_UNIFORM_DECLARATIONS = [
  "uniform vec3  iResolution;",
  "uniform float iTime;",
  "uniform float iTimeDelta;",
  "uniform float iFrameRate;",
  "uniform int   iFrame;",
  "uniform vec4  iMouse;",
  "uniform vec4  iDate;",
] as const;

const TAIL_UNIFORM_DECLARATIONS = [
  "uniform vec3  iChannelResolution[4];",
  "uniform float iChannelTime[4];",
  "uniform float iSampleRate;",
] as const;

function channelDeclarations(kinds: readonly ChannelKind[]): string[] {
  return kinds.map(
    (kind, index) =>
      `uniform ${kind === "3d" ? "sampler3D" : "sampler2D"} iChannel${index};`,
  );
}

/** Shadertoy Image Profile 支持的全部 uniform（占位通道见 channel-textures）。 */
export const UNIFORM_DECLARATIONS = [
  ...BASE_UNIFORM_DECLARATIONS,
  "uniform sampler2D iChannel0;",
  "uniform sampler2D iChannel1;",
  "uniform sampler2D iChannel2;",
  "uniform sampler2D iChannel3;",
  ...TAIL_UNIFORM_DECLARATIONS,
] as const;

/**
 * 按通道类型生成 uniform 声明：绑定到 Volume Pass 的通道声明为 `sampler3D`，
 * 其余为 `sampler2D`。不传 kinds 时与 UNIFORM_DECLARATIONS 等价。
 */
export function uniformDeclarations(kinds?: readonly ChannelKind[]): string[] {
  if (!kinds) return [...UNIFORM_DECLARATIONS];
  return [
    ...BASE_UNIFORM_DECLARATIONS,
    ...channelDeclarations(kinds),
    ...TAIL_UNIFORM_DECLARATIONS,
  ];
}

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
  "#ifndef texture2DLod",
  "#define texture2DLod(s, uv, lod) texture2D(s, uv)",
  "#endif",
  "#ifndef textureCubeLod",
  "#define textureCubeLod(s, uv, lod) textureCube(s, uv)",
  "#endif",
] as const;

/** ES 3.00 片段输出变量；由适配器声明，用户源码不用改。 */
export const ES3_OUTPUT_NAME = "lullFragColor";

/**
 * GLSL ES 3.00 兼容宏。
 *
 * ES3 里 `texture*` 是核心函数，但很多 Shadertoy 源码仍写 `texture2D`；`varying`
 * 也已经改成 `in`。这里只做名称映射，不改采样语义。
 */
export const ES3_COMPATIBILITY_MACROS = [
  "#define HW_PERFORMANCE 1",
  "#define texture2D texture",
  "#define textureCube texture",
  "#define texture2DLod textureLod",
  "#define textureCubeLod textureLod",
  "#define texture2DProj textureProj",
  "#define varying in",
] as const;
