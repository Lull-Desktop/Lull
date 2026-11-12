/**
 * Shadertoy Image → WebGL 片段着色器适配（RFC §6.1 / §7）。
 *
 * 只做结构性拼接：入口包装、uniform 声明、兼容宏、`#extension` 上提。
 * 不做语义改写，也不尝试“修复”用户代码；编译失败原样上报。
 *
 * ES 3.00 路径只在 WebGL2 可用时启用：它让 `texelFetch` / `textureSize` /
 * 整数位运算等 Shadertoy 常见 ES3 写法原样编译；ES 1.00 路径保持原行为。
 */
import { diagnostic, type ShaderDiagnostic } from "../runtime/diagnostics";
import type { GlslDialect } from "../source/source-model";
import { normalizeSource, stripGlslComments } from "../source/source-profile";
import {
  type ChannelKind,
  COMPATIBILITY_MACROS,
  ES3_COMPATIBILITY_MACROS,
  ES3_OUTPUT_NAME,
  ES3_VERTEX_SHADER_SOURCE,
  OWNED_UNIFORM_NAMES,
  uniformDeclarations,
  VERTEX_SHADER_SOURCE,
} from "./shader-template";

export type AdaptedShader = {
  vertexSource: string;
  fragmentSource: string;
  /** 生成源码里用户源码之前附加的行数（用于提示编译日志行号偏移）。 */
  lineOffset: number;
  warnings: string[];
};

export type AdaptOptions = {
  /** 当前 WebGL 上下文是否支持 OES_standard_derivatives。 */
  derivativesSupported: boolean;
  /** 目标 GLSL 版本；默认保持 ES 1.00。 */
  dialect?: GlslDialect;
  /** 每个通道的纹理类型；绑定到 Volume Pass 的通道为 3d。默认全部 2d。 */
  channelKinds?: readonly ChannelKind[];
};

export type AdaptResult =
  | { ok: true; shader: AdaptedShader }
  | { ok: false; diagnostic: ShaderDiagnostic };

const VERSION_LINE = /^[ \t]*#version\b.*$/;
const EXTENSION_LINE = /^[ \t]*#extension\b.*$/;
const UNIFORM_LINE =
  /^[ \t]*uniform[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?\w+[ \t]+([A-Za-z_]\w*)[ \t]*(?:\[[^\]]*\])?[ \t]*;[ \t]*$/;
const DERIVATIVES = /\b(?:dFdx|dFdy|fwidth)\s*\(/;
const TEXTURE_LOD =
  /\b(?:textureLod|textureGrad|texture2DLod|textureCubeLod)\s*\(/;
const MAIN_IMAGE = /\bvoid\s+mainImage\s*\(/;
const FRAG_COLOR = /\bgl_FragColor\b/;
/** ES3 核心已包含、继续保留 `#extension` 反而会报 unsupported 的旧扩展。 */
const ES1_ONLY_EXTENSION =
  /GL_OES_standard_derivatives|GL_EXT_shader_texture_lod/;

export type StrippedDirectives = {
  /** 去掉 #version / #extension / 内建 uniform 后的用户源码行。 */
  bodyLines: string[];
  extensions: string[];
  strippedVersion: boolean;
  strippedUniforms: number;
  droppedExtensions: number;
};

/** Image / Volume 适配器共用的指令剥离（不改用户代码语义）。 */
export function stripShaderDirectives(
  normalized: string,
  isEs3: boolean,
): StrippedDirectives {
  const bodyLines: string[] = [];
  const extensions: string[] = [];
  let strippedVersion = false;
  let strippedUniforms = 0;
  let droppedExtensions = 0;

  for (const line of normalized.split("\n")) {
    if (VERSION_LINE.test(line)) {
      strippedVersion = true;
      continue;
    }
    const extension = EXTENSION_LINE.exec(line)?.[0]?.trim();
    if (extension !== undefined) {
      if (isEs3 && ES1_ONLY_EXTENSION.test(extension)) {
        droppedExtensions += 1;
        continue;
      }
      if (!extensions.includes(extension)) extensions.push(extension);
      continue;
    }
    const uniform = UNIFORM_LINE.exec(line);
    if (uniform?.[1] !== undefined && OWNED_UNIFORM_NAMES.has(uniform[1])) {
      strippedUniforms += 1;
      continue;
    }
    bodyLines.push(line);
  }
  return {
    bodyLines,
    extensions,
    strippedVersion,
    strippedUniforms,
    droppedExtensions,
  };
}

/** Image / Volume 适配器共用的剥离提示。 */
export function directiveWarnings(
  stripped: StrippedDirectives,
  isEs3: boolean,
): string[] {
  const warnings: string[] = [];
  if (stripped.strippedVersion) {
    warnings.push(
      isEs3
        ? "已忽略源码中的 #version，统一按 GLSL ES 3.00 编译。"
        : "已忽略源码中的 #version（运行时固定使用 GLSL ES 1.00）。",
    );
  }
  if (stripped.strippedUniforms > 0) {
    warnings.push(
      `已忽略源码中重复声明的 ${stripped.strippedUniforms} 个内建 uniform（由运行时提供）。`,
    );
  }
  if (stripped.extensions.length > 0) {
    warnings.push(
      `已将 ${stripped.extensions.length} 条 #extension 上提到源码开头。`,
    );
  }
  if (stripped.droppedExtensions > 0) {
    warnings.push(
      `已在 ES 3.00 路径中忽略 ${stripped.droppedExtensions} 条仅 ES 1.00 需要的 #extension。`,
    );
  }
  return warnings;
}

export function adaptShadertoyImage(
  source: string,
  options: AdaptOptions,
): AdaptResult {
  const normalized = normalizeSource(source);
  const isEs3 = options.dialect === 300;
  const stripped = stripShaderDirectives(normalized, isEs3);
  const { bodyLines, extensions } = stripped;
  const warnings: string[] = [];

  const code = stripGlslComments(normalized);
  if (!MAIN_IMAGE.test(code)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-entry",
        "缺少入口函数 void mainImage(out vec4 fragColor, in vec2 fragCoord)。 / Missing entry point mainImage(out vec4, in vec2).",
      ),
    };
  }

  const derivativesUsed = DERIVATIVES.test(code);
  const hasDerivativePragma = extensions.some((line) =>
    /GL_OES_standard_derivatives/.test(line),
  );
  if (
    !isEs3 &&
    derivativesUsed &&
    !hasDerivativePragma &&
    !options.derivativesSupported
  ) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-feature",
        "源码使用了导数函数（dFdx/dFdy/fwidth），但当前 WebGL 上下文不支持 OES_standard_derivatives。 / Derivatives need OES_standard_derivatives, which this WebGL context lacks.",
        "dFdx / dFdy / fwidth",
      ),
    };
  }

  const header: string[] = [];
  if (isEs3) header.push("#version 300 es");
  if (extensions.length > 0) header.push(...extensions);
  if (!isEs3 && derivativesUsed && !hasDerivativePragma) {
    header.push("#extension GL_OES_standard_derivatives : enable");
  }
  header.push("precision highp float;", "precision highp int;");
  if (options.channelKinds?.includes("3d")) {
    // 采样 Volume 通道时需要 sampler3D；ES 3.00 里它没有默认精度。
    header.push("precision highp sampler3D;");
  }
  header.push(...uniformDeclarations(options.channelKinds));
  if (isEs3) {
    header.push(`out vec4 ${ES3_OUTPUT_NAME};`);
    header.push(...ES3_COMPATIBILITY_MACROS);
    if (FRAG_COLOR.test(code)) {
      header.push(`#define gl_FragColor ${ES3_OUTPUT_NAME}`);
    }
  } else {
    header.push(...COMPATIBILITY_MACROS);
  }

  const body = bodyLines.join("\n").trim();
  const output = isEs3 ? ES3_OUTPUT_NAME : "gl_FragColor";
  const lines = [
    ...header,
    "",
    "// ---- user source ----",
    body,
    "",
    "void main() {",
    "  vec4 lullColor = vec4(0.0, 0.0, 0.0, 1.0);",
    "  mainImage(lullColor, gl_FragCoord.xy);",
    `  ${output} = lullColor;`,
    "}",
    "",
  ];

  warnings.push(...directiveWarnings(stripped, isEs3));
  if (!isEs3 && TEXTURE_LOD.test(code)) {
    warnings.push(
      "textureLod / textureGrad 在 GLSL ES 1.00 下退化为普通采样（无 mipmap LOD）。",
    );
  }

  return {
    ok: true,
    shader: {
      vertexSource: isEs3 ? ES3_VERTEX_SHADER_SOURCE : VERTEX_SHADER_SOURCE,
      fragmentSource: lines.join("\n"),
      // header 之后还有一行空行与一行注释，才是用户源码的第一行。
      lineOffset: header.length + 2,
      warnings,
    },
  };
}
