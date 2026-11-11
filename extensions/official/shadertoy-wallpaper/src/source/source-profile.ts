/**
 * 源码识别（对应 RFC §6）：判断文本是否符合首版支持的入口约定。
 *
 * 只做「结构识别」，不代替编译：真正的最终判定始终是 WebGL 编译/链接结果。
 * 识别时先剥离注释，避免 `// iChannel0 …` 这类说明文字被误判成输入依赖。
 */
import { diagnostic, type ShaderDiagnostic } from "../runtime/diagnostics";
import {
  MAX_SOURCE_CHARS,
  RAW_FRAGMENT_PROFILE,
  type ShaderProfile,
  SUPPORTED_PROFILE,
} from "./source-model";

export type ProfileCheck =
  | { ok: true; profile: ShaderProfile; source: string }
  | { ok: false; diagnostic: ShaderDiagnostic };

/** 统一换行与 BOM，保证后续按行处理稳定。 */
export function normalizeSource(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/**
 * 去掉 GLSL 注释，保留换行（GLSL ES 1.00 没有字符串字面量，剥离是安全的）。
 */
export function stripGlslComments(source: string): string {
  let out = "";
  let index = 0;
  while (index < source.length) {
    const current = source[index];
    const next = source[index + 1];
    if (current === "/" && next === "/") {
      index += 2;
      while (index < source.length && source[index] !== "\n") index += 1;
      continue;
    }
    if (current === "/" && next === "*") {
      index += 2;
      while (
        index < source.length &&
        !(source[index] === "*" && source[index + 1] === "/")
      ) {
        if (source[index] === "\n") out += "\n";
        index += 1;
      }
      index += 2;
      continue;
    }
    out += current;
    index += 1;
  }
  return out;
}

const VERSION_LINE = /^[ \t]*#version\b(.*)$/m;
const MAIN_IMAGE = /\bvoid\s+mainImage\s*\(/;
const MAIN = /\bvoid\s+main\s*\(/;
const EXTERNAL_INPUTS =
  /\bi(?:Channel[0-3]|ChannelResolution|ChannelTime|SampleRate)\b/g;
const INCLUDE = /^[ \t]*#include\b/m;
const SHADER_BLOCK =
  /<script\b[^>]*type\s*=\s*["']x-shader\/x-fragment["'][^>]*>/gi;
const SCRIPT_ID = /\bid\s*=\s*["']([^"']+)["']/i;
const HTML_MARKUP = /<!doctype\b|<html\b|<head\b|<body\b|<canvas\b|<script\b/i;
const JS_ONLY =
  /=>|\bdocument\.|\bwindow\.|\bconsole\.|\bMath\.|\bperformance\.now\b|\bfunction\s+\w+\s*\(|\bconst\s+\w+\s*=\s*\[/;

/**
 * 返回源码里引用到的 Shadertoy 外部输入名（去重）。
 *
 * 这些输入不再导致拒绝：运行时用占位通道（iChannel0 噪声 / 其余黑色）代替，
 * 并据此提示用户视觉不等价。
 */
export function findExternalInputs(source: string): string[] {
  const found = new Set<string>();
  const code = stripGlslComments(source);
  for (const match of code.matchAll(EXTERNAL_INPUTS)) {
    if (match[0]) found.add(match[0]);
  }
  return [...found];
}

export function detectShaderProfile(raw: string): ProfileCheck {
  const source = normalizeSource(raw);
  if (source.trim() === "") {
    return {
      ok: false,
      diagnostic: diagnostic(
        "source-empty",
        "着色器源码为空。 / The shader source is empty.",
      ),
    };
  }
  if (source.length > MAX_SOURCE_CHARS) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "source-too-large",
        `源码超过上限（${Math.round(MAX_SOURCE_CHARS / 1024)} KiB）。 / The source exceeds the ${Math.round(MAX_SOURCE_CHARS / 1024)} KiB limit.`,
        `${source.length} characters`,
      ),
    };
  }

  const code = stripGlslComments(source);

  const blocks = [...code.matchAll(SHADER_BLOCK)];
  if (blocks.length > 0) {
    const ids = blocks
      .map((block) => SCRIPT_ID.exec(block[0])?.[1])
      .filter((id): id is string => id !== undefined);
    const label = ids.length > 0 ? ` (${ids.join(", ")})` : "";
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-source",
        blocks.length > 1
          ? `检测到 ${blocks.length} 个 fragment shader 块${label}，属于多 Pass 示例；当前只支持单个 GLSL 源码。请只粘贴其中一个 shader 的代码，不要粘贴整页 HTML/JS。 / Found ${blocks.length} fragment shader blocks${label}; multi-pass demos are not supported. Paste one shader's GLSL, not the whole page.`
          : `检测到网页里的 shader 块${label}，请只粘贴其中的 GLSL 源码，不要包含 HTML/JS。 / Found a shader block inside a web page; paste only its GLSL source.`,
        `${blocks.length} fragment shader block(s)${label}`,
      ),
    };
  }
  if (HTML_MARKUP.test(code)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-source",
        '检测到 HTML 页面，而不是 GLSL 源码。请只粘贴 <script type="x-shader/x-fragment"> 里的 GLSL。 / This looks like HTML, not GLSL. Paste only the shader source.',
      ),
    };
  }
  if (JS_ONLY.test(code)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-source",
        "检测到 JavaScript 代码，而不是 GLSL 源码。请只粘贴 GLSL（mainImage 或 main()）。 / This looks like JavaScript, not GLSL. Paste the GLSL shader only.",
      ),
    };
  }

  const version = VERSION_LINE.exec(code)?.[1]?.trim() ?? null;
  if (version !== null && version !== "" && version !== "100") {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-version",
        "首版只支持 GLSL ES 1.00，请去掉 #version 或改为 #version 100。 / Only GLSL ES 1.00 is supported; remove the #version line or use #version 100.",
        `#version ${version}`,
      ),
    };
  }

  if (INCLUDE.test(code)) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-input",
        "不支持 #include / 多文件源码；请把需要的代码合并进同一个文件。 / #include and multi-file sources are not supported.",
      ),
    };
  }

  const hasMainImage = MAIN_IMAGE.test(code);
  const hasMain = MAIN.test(code);
  if (hasMainImage && hasMain) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-entry",
        "源码同时包含 mainImage 与自定义 main；请只保留一个入口。 / The source declares both mainImage and main; keep only one entry point.",
      ),
    };
  }
  if (hasMain) {
    return { ok: true, profile: RAW_FRAGMENT_PROFILE, source };
  }
  if (!hasMainImage) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-entry",
        "缺少入口函数 void mainImage(out vec4 fragColor, in vec2 fragCoord) 或 void main()。 / Missing entry point mainImage(out vec4, in vec2) or main().",
      ),
    };
  }

  return { ok: true, profile: SUPPORTED_PROFILE, source };
}
