/**
 * Shadertoy Image → WebGL1 片段着色器适配（RFC §6.1 / §7）。
 *
 * 只做结构性拼接：入口包装、uniform 声明、兼容宏、`#extension` 上提。
 * 不做语义改写，也不尝试“修复”用户代码；编译失败原样上报。
 */
import { diagnostic, type ShaderDiagnostic } from "../runtime/diagnostics";
import { normalizeSource, stripGlslComments } from "../source/source-profile";
import {
  COMPATIBILITY_MACROS,
  OWNED_UNIFORM_NAMES,
  UNIFORM_DECLARATIONS,
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
};

export type AdaptResult =
  | { ok: true; shader: AdaptedShader }
  | { ok: false; diagnostic: ShaderDiagnostic };

const VERSION_LINE = /^[ \t]*#version\b.*$/;
const EXTENSION_LINE = /^[ \t]*#extension\b.*$/;
const UNIFORM_LINE =
  /^[ \t]*uniform[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?\w+[ \t]+([A-Za-z_]\w*)[ \t]*(?:\[[^\]]*\])?[ \t]*;[ \t]*$/;
const DERIVATIVES = /\b(?:dFdx|dFdy|fwidth)\s*\(/;
const TEXTURE_LOD = /\btexture(?:Lod|Grad)\s*\(/;
const MAIN_IMAGE = /\bvoid\s+mainImage\s*\(/;

export function adaptShadertoyImage(
  source: string,
  options: AdaptOptions,
): AdaptResult {
  const normalized = normalizeSource(source);
  const bodyLines: string[] = [];
  const extensions: string[] = [];
  const warnings: string[] = [];
  let strippedVersion = false;
  let strippedUniforms = 0;

  for (const line of normalized.split("\n")) {
    if (VERSION_LINE.test(line)) {
      strippedVersion = true;
      continue;
    }
    const extension = EXTENSION_LINE.exec(line)?.[0]?.trim();
    if (extension !== undefined) {
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
  if (extensions.length > 0) header.push(...extensions);
  if (derivativesUsed && !hasDerivativePragma) {
    header.push("#extension GL_OES_standard_derivatives : enable");
  }
  header.push(
    "precision highp float;",
    "precision highp int;",
    ...UNIFORM_DECLARATIONS,
    ...COMPATIBILITY_MACROS,
  );

  const body = bodyLines.join("\n").trim();
  const lines = [
    ...header,
    "",
    "// ---- user source ----",
    body,
    "",
    "void main() {",
    "  vec4 lullColor = vec4(0.0, 0.0, 0.0, 1.0);",
    "  mainImage(lullColor, gl_FragCoord.xy);",
    "  gl_FragColor = lullColor;",
    "}",
    "",
  ];

  if (strippedVersion) {
    warnings.push("已忽略源码中的 #version（首版固定使用 GLSL ES 1.00）。");
  }
  if (strippedUniforms > 0) {
    warnings.push(
      `已忽略源码中重复声明的 ${strippedUniforms} 个内建 uniform（由运行时提供）。`,
    );
  }
  if (extensions.length > 0) {
    warnings.push(`已将 ${extensions.length} 条 #extension 上提到源码开头。`);
  }
  if (TEXTURE_LOD.test(code)) {
    warnings.push(
      "textureLod / textureGrad 在 GLSL ES 1.00 下退化为普通采样（无 mipmap LOD）。",
    );
  }

  return {
    ok: true,
    shader: {
      vertexSource: VERTEX_SHADER_SOURCE,
      fragmentSource: lines.join("\n"),
      // header 之后还有一行空行与一行注释，才是用户源码的第一行。
      lineOffset: header.length + 2,
      warnings,
    },
  };
}
