/**
 * 源码识别（对应 RFC §6）：判断文本是否符合支持的入口约定。
 *
 * 只做「结构识别」，不代替编译：真正的最终判定始终是 WebGL 编译/链接结果。
 * 识别时先剥离注释，避免 `// iChannel0 …` 这类说明文字被误判成输入依赖。
 *
 * 这里只标记源码「需要」哪个 GLSL 版本；环境是否提供 WebGL2 由 renderer 判断，
 * 这样同一份源码在 WebGL1 上能给出明确的“需要 WebGL2”诊断，而不是难懂的编译错误。
 */
import { diagnostic, type ShaderDiagnostic } from "../runtime/diagnostics";
import {
  type GlslDialect,
  MAX_SOURCE_CHARS,
  RAW_FRAGMENT_PROFILE,
  type ShaderProfile,
  SUPPORTED_PROFILE,
  VOLUME_PROFILE,
} from "./source-model";

export type ProfileCheck =
  | {
      ok: true;
      profile: ShaderProfile;
      source: string;
      /** 编译时实际需要的 GLSL 版本。 */
      dialect: GlslDialect;
      /** 源码显式声明的 `#version`（没有则为 null）。 */
      declaredVersion: GlslDialect | null;
      /** 命中的 ES3-only 语法；用于 WebGL1 的明确诊断。 */
      es3Features: string[];
      /** 是否使用导数函数；WebGL2 下会改走 ES3（ES1 导数在 WebGL2 中不可用）。 */
      usesDerivatives: boolean;
      /** 是否使用显式 LOD/Grad 采样；WebGL2 下走 ES3 以保留语义。 */
      usesTextureLod: boolean;
    }
  | { ok: false; diagnostic: ShaderDiagnostic };

/** 统一换行与 BOM，保证后续按行处理稳定。 */
export function normalizeSource(raw: string): string {
  const withoutBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
  return withoutBom.replace(/\r\n?/g, "\n");
}

/**
 * 去掉 GLSL 注释，保留换行（GLSL ES 1.00/3.00 没有字符串字面量，剥离是安全的）。
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
const MAIN_VOLUME = /\bvoid\s+mainVolume\s*\(/;
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
const DERIVATIVES = /\b(?:dFdx|dFdy|fwidth)\s*\(/;
const TEXTURE_LOD =
  /\b(?:textureLod|textureGrad|texture2DLod|textureCubeLod)\s*\(/;
/** GLSL ES 3.00 才有的语法；ES1 编译只会得到难懂的 texelFetch/类型错误。 */
const ES3_FEATURES = [
  { name: "texelFetch", pattern: /\btexelFetch\s*\(/ },
  { name: "textureSize", pattern: /\btextureSize\s*\(/ },
  { name: "整数数组", pattern: /\bint\s*\[\s*\]/ },
  {
    name: "位运算",
    pattern: /<<|>>|(?<![&])&(?![&=])|(?<![|])\|(?![|=])|\^|~(?!=)/,
  },
  { name: "switch", pattern: /\bswitch\s*\(/ },
  { name: "无符号整数", pattern: /\b(?:uint|uvec[234])\b/ },
  {
    // ES3 数组构造器：vec4[N](...) / float[8](...)；ES1 只有常量数组声明。
    name: "数组构造器",
    pattern:
      /\b(?:vec[234]|ivec[234]|uvec[234]|bvec[234]|mat[234]|float|int|uint)\s*\[\s*\w*\s*\]\s*\(/,
  },
  { name: "round", pattern: /\bround\s*\(/ },
  { name: "gl_FragDepth", pattern: /\bgl_FragDepth\b/ },
  { name: "layout", pattern: /\blayout\s*\(/ },
  {
    // 全局 in/out 声明是 ES3 语法；函数参数里的 in/out 不会匹配（行尾是逗号/括号）。
    name: "全局 in/out",
    pattern:
      /^[ \t]*(?:in|out)\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+\w+\s*(?:\[[^\]]*\])?\s*;/m,
  },
] as const;

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

function parseDeclaredVersion(
  versionText: string,
): GlslDialect | null | undefined {
  if (versionText === "" || versionText === "100") return 100;
  if (versionText === "300" || versionText === "300 es") return 300;
  return undefined;
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

  const versionText = VERSION_LINE.exec(code)?.[1]?.trim() ?? null;
  let declaredVersion: GlslDialect | null = null;
  if (versionText !== null) {
    const parsed = parseDeclaredVersion(versionText);
    if (parsed === undefined) {
      return {
        ok: false,
        diagnostic: diagnostic(
          "unsupported-version",
          "当前运行时支持 GLSL ES 1.00 与 300 es；其他版本需要对应的 WebGL 上下文。 / Only GLSL ES 1.00 and 300 es are supported.",
          `#version ${versionText}`,
        ),
      };
    }
    declaredVersion = parsed;
  }

  const es3Features = ES3_FEATURES.filter(({ pattern }) =>
    pattern.test(code),
  ).map(({ name }) => name);
  const usesDerivatives = DERIVATIVES.test(code);
  const usesTextureLod = TEXTURE_LOD.test(code);
  const dialect: GlslDialect =
    declaredVersion === 300 || es3Features.length > 0 ? 300 : 100;

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
  const hasMainVolume = MAIN_VOLUME.test(code);
  const hasMain = MAIN.test(code);
  const entryCount =
    Number(hasMainImage) + Number(hasMainVolume) + Number(hasMain);
  if (entryCount > 1) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-entry",
        "源码同时包含多个入口（mainImage / mainVolume / main）；请只保留一个。 / The source declares multiple entry points; keep only one.",
      ),
    };
  }

  if (hasMainVolume) {
    return {
      ok: true,
      profile: VOLUME_PROFILE,
      source,
      // 体积纹理（sampler3D）只能走 ES 3.00 / WebGL2。
      dialect: 300,
      declaredVersion,
      es3Features,
      usesDerivatives,
      usesTextureLod,
    };
  }
  if (hasMain) {
    return {
      ok: true,
      profile: RAW_FRAGMENT_PROFILE,
      source,
      dialect,
      declaredVersion,
      es3Features,
      usesDerivatives,
      usesTextureLod,
    };
  }
  if (!hasMainImage) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "unsupported-entry",
        "缺少入口函数 void mainImage(out vec4 fragColor, in vec2 fragCoord)、void mainVolume(out vec4, in vec3) 或 void main()。 / Missing entry point mainImage(out vec4, in vec2), mainVolume(out vec4, in vec3) or main().",
      ),
    };
  }

  return {
    ok: true,
    profile: SUPPORTED_PROFILE,
    source,
    dialect,
    declaredVersion,
    es3Features,
    usesDerivatives,
    usesTextureLod,
  };
}
