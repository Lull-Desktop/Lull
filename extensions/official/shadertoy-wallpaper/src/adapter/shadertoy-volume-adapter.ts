/**
 * Shadertoy Volume → WebGL2 片段着色器适配（Volume A-D，3D 体积纹理）。
 *
 * 入口是 `void mainVolume(out vec4 O, vec3 V)`：V 是体素坐标（像素中心，
 * 范围 [0.5, size-0.5]）。运行时把体积分成 size 个 slice，逐 slice 用全屏
 * 四边形渲染到 3D 纹理的对应层；`uLullVolumeSlice` 由运行时按层设置。
 *
 * 体积纹理（sampler3D / texelFetch ivec3）只能走 GLSL ES 3.00 / WebGL2；
 * 绑定到 Volume Pass 的通道声明为 sampler3D，其余通道仍是 sampler2D。
 */
import { diagnostic } from "../runtime/diagnostics";
import { normalizeSource, stripGlslComments } from "../source/source-profile";
import {
  type ChannelKind,
  ES3_COMPATIBILITY_MACROS,
  ES3_OUTPUT_NAME,
  ES3_VERTEX_SHADER_SOURCE,
  uniformDeclarations,
  VOLUME_SLICE_UNIFORM,
} from "./shader-template";
import {
  type AdaptResult,
  directiveWarnings,
  stripShaderDirectives,
} from "./shadertoy-image-adapter";

export type VolumeAdaptOptions = {
  /** 每个通道的纹理类型；绑定到 Volume Pass 的通道为 3d。 */
  channelKinds: readonly ChannelKind[];
};

const MAIN_VOLUME = /\bvoid\s+mainVolume\s*\(/;
const FRAG_COLOR = /\bgl_FragColor\b/;

export function adaptShadertoyVolume(
  source: string,
  options: VolumeAdaptOptions,
): AdaptResult {
  const normalized = normalizeSource(source);
  const stripped = stripShaderDirectives(normalized, true);
  const code = stripGlslComments(normalized);

  if (!MAIN_VOLUME.test(code)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-entry",
        "Volume 分节缺少入口函数 void mainVolume(out vec4 O, vec3 V)。 / Volume sections need the entry point mainVolume(out vec4, in vec3).",
      ),
    };
  }

  const warnings = directiveWarnings(stripped, true);
  const header: string[] = [
    "#version 300 es",
    ...stripped.extensions,
    "precision highp float;",
    "precision highp int;",
    // ES 3.00 片段着色器里 sampler3D 没有默认精度，必须显式声明。
    "precision highp sampler3D;",
    ...uniformDeclarations(options.channelKinds),
    `out vec4 ${ES3_OUTPUT_NAME};`,
    `uniform float ${VOLUME_SLICE_UNIFORM};`,
    ...ES3_COMPATIBILITY_MACROS,
  ];
  if (FRAG_COLOR.test(code)) {
    header.push(`#define gl_FragColor ${ES3_OUTPUT_NAME}`);
  }

  const body = stripped.bodyLines.join("\n").trim();
  const lines = [
    ...header,
    "",
    "// ---- user source ----",
    body,
    "",
    "void main() {",
    "  vec4 lullColor = vec4(0.0, 0.0, 0.0, 1.0);",
    `  mainVolume(lullColor, vec3(gl_FragCoord.xy, ${VOLUME_SLICE_UNIFORM} + 0.5));`,
    `  ${ES3_OUTPUT_NAME} = lullColor;`,
    "}",
    "",
  ];

  return {
    ok: true,
    shader: {
      vertexSource: ES3_VERTEX_SHADER_SOURCE,
      fragmentSource: lines.join("\n"),
      lineOffset: header.length + 2,
      warnings,
    },
  };
}
