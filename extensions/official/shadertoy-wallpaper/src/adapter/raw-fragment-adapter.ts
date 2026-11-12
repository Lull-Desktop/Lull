/**
 * 普通 fragment shader（自定义 `main()`）→ WebGL 适配。
 *
 * 与 Shadertoy Image 适配共用同一套 uniform / 兼容宏 / 通道占位，但不再包装
 * `mainImage`：用户源码本身就是完整的片段着色器，直接编译。
 *
 * ES 3.00 路径兼容两种写法：显式 `out vec4 fragColor;`，以及 ES1 风格的
 * `gl_FragColor`（必要时注入输出变量并做名称映射）。
 *
 * 不做语义改写；`#version`、重复的内建 uniform 声明和 `#extension` 仅做结构处理。
 */
import { diagnostic, type ShaderDiagnostic } from "../runtime/diagnostics";
import { normalizeSource, stripGlslComments } from "../source/source-profile";
import {
  COMPATIBILITY_MACROS,
  ES3_COMPATIBILITY_MACROS,
  ES3_OUTPUT_NAME,
  ES3_VERTEX_SHADER_SOURCE,
  OWNED_UNIFORM_NAMES,
  UNIFORM_DECLARATIONS,
  VERTEX_SHADER_SOURCE,
} from "./shader-template";
import type { AdaptedShader, AdaptOptions } from "./shadertoy-image-adapter";

export type RawFragmentResult =
  | { ok: true; shader: AdaptedShader }
  | { ok: false; diagnostic: ShaderDiagnostic };

const VERSION_LINE = /^[ \t]*#version\b.*$/;
const EXTENSION_LINE = /^[ \t]*#extension\b.*$/;
const UNIFORM_LINE =
  /^[ \t]*uniform[ \t]+(?:(?:lowp|mediump|highp)[ \t]+)?\w+[ \t]+([A-Za-z_]\w*)[ \t]*(?:\[[^\]]*\])?[ \t]*;[ \t]*$/;
const DERIVATIVES = /\b(?:dFdx|dFdy|fwidth)\s*\(/;
const TEXTURE_LOD =
  /\b(?:textureLod|textureGrad|texture2DLod|textureCubeLod)\s*\(/;
const MAIN = /\bvoid\s+main\s*\(/;
const FRAG_COLOR = /\bgl_FragColor\b/;
const FRAG_DATA = /\bgl_FragData\b/;
const OUT_DECLARATION =
  /(?:^|\n)[ \t]*(?:layout\s*\([^)]*\)\s*)?out\s+(?:(?:lowp|mediump|highp)\s+)?(?:\w+)\s+([A-Za-z_]\w*)\s*(?:\[[^\]]*\])?[ \t]*;/;
const ES1_ONLY_EXTENSION =
  /GL_OES_standard_derivatives|GL_EXT_shader_texture_lod/;
const FRAG_DATA_OUTPUT = "lullFragData";

export function adaptRawFragment(
  source: string,
  options: AdaptOptions,
): RawFragmentResult {
  const normalized = normalizeSource(source);
  const isEs3 = options.dialect === 300;
  const bodyLines: string[] = [];
  const extensions: string[] = [];
  const warnings: string[] = [];
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

  const code = stripGlslComments(normalized);
  if (!MAIN.test(code)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-entry",
        "缺少入口函数 void main()。 / Missing entry point void main().",
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
  header.push(
    "precision highp float;",
    "precision highp int;",
    ...UNIFORM_DECLARATIONS,
  );

  if (isEs3) {
    const usesFragColor = FRAG_COLOR.test(code);
    const usesFragData = FRAG_DATA.test(code);
    const declaredOutput = OUT_DECLARATION.exec(code)?.[1] ?? null;
    const outputLines: string[] = [];
    const macros: string[] = [];

    if (usesFragColor) {
      if (declaredOutput) {
        // 用户已经有 out 变量：把 gl_FragColor 映射过去，避免声明第二个输出。
        macros.push(`#define gl_FragColor ${declaredOutput}`);
      } else {
        outputLines.push(`out vec4 ${ES3_OUTPUT_NAME};`);
        macros.push(`#define gl_FragColor ${ES3_OUTPUT_NAME}`);
      }
    }
    if (usesFragData) {
      outputLines.push(`out vec4 ${FRAG_DATA_OUTPUT}[1];`);
      macros.push(`#define gl_FragData ${FRAG_DATA_OUTPUT}`);
    }

    if (outputLines.length > 0) header.push(...outputLines);
    header.push(...ES3_COMPATIBILITY_MACROS);
    if (macros.length > 0) header.push(...macros);
  } else {
    header.push(...COMPATIBILITY_MACROS);
  }

  const body = bodyLines.join("\n").trim();
  const lines = [...header, "", "// ---- user source ----", body, ""];

  if (strippedVersion) {
    warnings.push(
      isEs3
        ? "已忽略源码中的 #version，统一按 GLSL ES 3.00 编译。"
        : "已忽略源码中的 #version（运行时固定使用 GLSL ES 1.00）。",
    );
  }
  if (strippedUniforms > 0) {
    warnings.push(
      `已忽略源码中重复声明的 ${strippedUniforms} 个内建 uniform（由运行时提供）。`,
    );
  }
  if (extensions.length > 0) {
    warnings.push(`已将 ${extensions.length} 条 #extension 上提到源码开头。`);
  }
  if (droppedExtensions > 0) {
    warnings.push(
      `已在 ES 3.00 路径中忽略 ${droppedExtensions} 条仅 ES 1.00 需要的 #extension。`,
    );
  }
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
