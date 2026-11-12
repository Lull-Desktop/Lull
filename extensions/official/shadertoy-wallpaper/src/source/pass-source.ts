/**
 * Shadertoy 多 Pass 源码解析（RFC §6.1）。
 *
 * 单 Pass 源码保持原样；多 Pass 用行注释分节，代码本体不改（推荐写法）：
 *
 * ```glsl
 * //==== Common ====
 * //==== Volume A ====
 * //==== Buffer A ====
 * //==== Image A ====
 * //==== Image ====
 * //==== Bindings ====
 * BufferA.iChannel0 = VolumeA
 * Image.iChannel0 = ImageA
 * VolumeA.size = 128
 * ```
 *
 * 也接受 `//---- X ----`、`//== X`、`// @pass X`、`// @bindings` 等别名。
 *
 * 只有出现分节标记时才进入多 Pass 模式；Bindings 是运行配置，不是 GLSL。
 *
 * Pass 类型：
 * - `Buffer A-D`：2D 反馈缓冲（mainImage）；
 * - `Volume A-D`：3D 体积纹理（mainVolume，仅 WebGL2 / ES 3.00）；
 * - `Image A-D`：额外 2D 图像 Pass（mainImage），可被其他 Pass 采样；
 * - `Image`：最终显示 Pass。缺少 Image 时，用最后一个 Image A-D 作为显示 Pass。
 *
 * 执行顺序固定为 Volume A-D → Buffer A-D → Image A-D → Image（显示 Pass 最后）。
 */
import { diagnostic, type ShaderDiagnostic } from "../runtime/diagnostics";
import { MAX_SOURCE_CHARS } from "./source-model";
import { normalizeSource, stripGlslComments } from "./source-profile";

export type BufferPassName = "BufferA" | "BufferB" | "BufferC" | "BufferD";
export type VolumePassName = "VolumeA" | "VolumeB" | "VolumeC" | "VolumeD";
export type ExtraImagePassName = "ImageA" | "ImageB" | "ImageC" | "ImageD";
export type ScenePassName =
  | BufferPassName
  | VolumePassName
  | ExtraImagePassName
  | "Image";
export type ChannelTarget = ScenePassName | "Noise" | "Black";
export type SectionName = "Common" | "Bindings" | ScenePassName;

export type ParsedPass = {
  name: ScenePassName;
  source: string;
};

export type PassBindings = Partial<
  Record<ScenePassName, Partial<Record<number, ChannelTarget>>>
>;

export type ParsedPassSource = {
  mode: "single" | "multipass";
  common: string;
  /** 按执行顺序排列；显示 Pass 始终是最后一个。 */
  passes: ParsedPass[];
  bindings: PassBindings;
  /** 渲染到屏幕的 Pass：Image，或（缺少 Image 时）最后一个 Image A-D。 */
  displayPass: ScenePassName;
  /** Bindings 里声明的体积纹理边长；未声明的体积 Pass 用运行时默认值。 */
  volumeSizes: Partial<Record<VolumePassName, number>>;
};

export type PassParseResult =
  | { ok: true; value: ParsedPassSource }
  | { ok: false; diagnostic: ShaderDiagnostic };

type ParseFailure = { ok: false; diagnostic: ShaderDiagnostic };

/** 分节标记 / 绑定里可引用的 Pass 名（不含 Common/Bindings）。 */
const PASS_NAMES =
  "Buffer[ \\t]*[A-D]|Volume[ \\t]*[A-D]|Image(?:[ \\t]*[A-D])?";
const PASS_REF = `(?:${PASS_NAMES})`;
const SECTION_REF = `(?:Common|Bindings|${PASS_NAMES})`;

const DECORATED_SECTION = new RegExp(
  `^[ \\t]*//[ \\t]*[-=*#+~]{2,}[ \\t]*(${SECTION_REF})[ \\t]*(?:[-=*#+~]{2,})?[ \\t]*$`,
  "i",
);
const DIRECTIVE_SECTION = new RegExp(
  `^[ \\t]*//[ \\t]*@(?:pass|section)[ \\t]+(${SECTION_REF})[ \\t]*$`,
  "i",
);
const BINDINGS_DIRECTIVE = /^[ \t]*\/\/[ \t]*@bindings[ \t]*$/i;
const BINDING = new RegExp(
  `^[ \\t]*(${PASS_REF})[ \\t]*\\.[ \\t]*iChannel([0-3])[ \\t]*=[ \\t]*(${PASS_REF}|Noise|Black)[ \\t]*$`,
  "i",
);
const VOLUME_SIZE =
  /^[ \t]*(Volume[ \t]*[A-D])[ \t]*\.[ \t]*size[ \t]*=[ \t]*(\d+)[ \t]*$/i;

const BUFFER_NAMES: BufferPassName[] = [
  "BufferA",
  "BufferB",
  "BufferC",
  "BufferD",
];
const VOLUME_NAMES: VolumePassName[] = [
  "VolumeA",
  "VolumeB",
  "VolumeC",
  "VolumeD",
];
const EXTRA_IMAGE_NAMES: ExtraImagePassName[] = [
  "ImageA",
  "ImageB",
  "ImageC",
  "ImageD",
];

/** 体积纹理边长允许范围（体素数）；默认值在 runtime/volume-target。 */
export const MIN_VOLUME_SIZE = 8;
export const MAX_VOLUME_SIZE = 256;

/** 匹配分节标记，返回原始名称；不是标记时返回 null。 */
function matchSection(line: string): string | null {
  const decorated = DECORATED_SECTION.exec(line);
  if (decorated?.[1]) return decorated[1];
  const directive = DIRECTIVE_SECTION.exec(line);
  if (directive?.[1]) return directive[1];
  if (BINDINGS_DIRECTIVE.test(line)) return "Bindings";
  return null;
}

function normalizeName(raw: string): SectionName | null {
  const compact = raw.replace(/\s+/g, "").toLowerCase();
  if (compact === "common") return "Common";
  if (compact === "bindings") return "Bindings";
  if (compact === "image") return "Image";
  const buffer = /^buffer([a-d])$/.exec(compact);
  if (buffer?.[1]) {
    return `Buffer${buffer[1].toUpperCase()}` as ScenePassName;
  }
  const volume = /^volume([a-d])$/.exec(compact);
  if (volume?.[1]) {
    return `Volume${volume[1].toUpperCase()}` as ScenePassName;
  }
  const image = /^image([a-d])$/.exec(compact);
  if (image?.[1]) {
    return `Image${image[1].toUpperCase()}` as ScenePassName;
  }
  return null;
}

function fail(message: string, detail?: string): ParseFailure {
  return {
    ok: false,
    diagnostic: diagnostic("unsupported-source", message, detail),
  };
}

function isScenePassName(value: SectionName | null): value is ScenePassName {
  return value !== null && value !== "Common" && value !== "Bindings";
}

function parseBindings(
  lines: string[],
  passNames: ReadonlySet<ScenePassName>,
):
  | {
      ok: true;
      bindings: PassBindings;
      volumeSizes: Partial<Record<VolumePassName, number>>;
    }
  | ParseFailure {
  const bindings: PassBindings = {};
  const volumeSizes: Partial<Record<VolumePassName, number>> = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) continue;

    const size = VOLUME_SIZE.exec(trimmed);
    if (size) {
      const passName = normalizeName(size[1] ?? "");
      if (!isScenePassName(passName) || !passNames.has(passName)) {
        return fail(`绑定引用了不存在的 Pass：${size[1]}`);
      }
      const value = Number(size[2]);
      if (value < MIN_VOLUME_SIZE || value > MAX_VOLUME_SIZE) {
        return fail(
          `体积纹理边长必须在 ${MIN_VOLUME_SIZE}-${MAX_VOLUME_SIZE} 之间：${trimmed}。 / Volume size must be ${MIN_VOLUME_SIZE}-${MAX_VOLUME_SIZE}.`,
        );
      }
      volumeSizes[passName as VolumePassName] = value;
      continue;
    }

    const match = BINDING.exec(trimmed);
    if (!match) {
      return fail(
        `无法解析通道绑定：${trimmed}。格式应为 Image.iChannel0 = BufferA 或 VolumeA.size = 128。 / Invalid channel binding.`,
        trimmed,
      );
    }

    const passName = normalizeName(match[1] ?? "");
    if (!isScenePassName(passName) || !passNames.has(passName)) {
      return fail(`绑定引用了不存在的 Pass：${match[1]}`);
    }

    const rawTarget = (match[3] ?? "").replace(/\s+/g, "").toLowerCase();
    let target: ChannelTarget;
    if (rawTarget === "noise") {
      target = "Noise";
    } else if (rawTarget === "black") {
      target = "Black";
    } else {
      const targetName = normalizeName(match[3] ?? "");
      if (
        !isScenePassName(targetName) ||
        targetName === "Image" ||
        !passNames.has(targetName)
      ) {
        return fail(`绑定目标不存在：${match[3]}`);
      }
      target = targetName;
    }

    bindings[passName] ??= {};
    bindings[passName][Number(match[2])] = target;
  }
  return { ok: true, bindings, volumeSizes };
}

export function parsePassSource(raw: string): PassParseResult {
  const source = normalizeSource(raw);
  if (source.length > MAX_SOURCE_CHARS) {
    return {
      ok: false,
      diagnostic: diagnostic(
        "source-too-large",
        `源码超过上限（${Math.round(MAX_SOURCE_CHARS / 1024)} KiB）。 / The source exceeds the ${Math.round(MAX_SOURCE_CHARS / 1024)} KiB limit.`,
      ),
    };
  }

  const sections = new Map<SectionName, string[]>();
  const preamble: string[] = [];
  let current: SectionName | null = null;
  let sawMarker = false;

  for (const line of source.split("\n")) {
    const marker = matchSection(line);
    if (marker !== null) {
      sawMarker = true;
      const name = normalizeName(marker);
      if (!name) return fail(`无法识别分节标记：${line}`);
      if (sections.has(name)) {
        return fail(`分节重复：${name}`, line);
      }
      sections.set(name, []);
      current = name;
      continue;
    }
    if (current === null) {
      preamble.push(line);
      continue;
    }
    sections.get(current)?.push(line);
  }

  if (!sawMarker) {
    const single = source.trim();
    if (single === "") {
      return fail("着色器源码为空。 / The shader source is empty.");
    }
    return {
      ok: true,
      value: {
        mode: "single",
        common: "",
        passes: [{ name: "Image", source: single }],
        bindings: {},
        displayPass: "Image",
        volumeSizes: {},
      },
    };
  }

  // 第一个标记之前允许空行与注释（标题/版权头），但不能有实际代码。
  if (stripGlslComments(preamble.join("\n")).trim() !== "") {
    return fail(
      "多 Pass 模式下，第一个分节标记之前不能有代码。 / Code before the first pass marker is not allowed.",
    );
  }

  // 显示 Pass：优先 Image；没有 Image 时用最后一个 Image A-D。
  let displayPass: ScenePassName;
  if (sections.has("Image")) {
    displayPass = "Image";
  } else {
    const extras = EXTRA_IMAGE_NAMES.filter((name) => sections.has(name));
    const last = extras[extras.length - 1];
    if (!last) {
      return fail(
        "多 Pass 源码缺少 Image 分节；请添加 //==== Image ====（或用 Image A-D 作为最终显示 Pass）。 / Multi-pass source is missing the Image section.",
      );
    }
    displayPass = last;
  }

  const passes: ParsedPass[] = [];
  const ordered: ScenePassName[] = [
    ...VOLUME_NAMES,
    ...BUFFER_NAMES,
    ...EXTRA_IMAGE_NAMES.filter((name) => name !== displayPass),
  ];
  for (const name of ordered) {
    const content = sections.get(name);
    if (!content) continue;
    const body = content.join("\n").trim();
    if (body === "")
      return fail(`${name} 分节为空。 / ${name} section is empty.`);
    passes.push({ name, source: body });
  }
  const displaySource = (sections.get(displayPass) ?? []).join("\n").trim();
  if (displaySource === "") {
    return fail(
      `${displayPass} 分节为空。 / The ${displayPass} section is empty.`,
    );
  }
  passes.push({ name: displayPass, source: displaySource });

  const passNames = new Set(passes.map((pass) => pass.name));
  const bindingsSection = sections.get("Bindings");
  let bindings: PassBindings = {};
  let volumeSizes: Partial<Record<VolumePassName, number>> = {};
  if (bindingsSection) {
    const parsed = parseBindings(bindingsSection, passNames);
    if (!parsed.ok) return parsed;
    bindings = parsed.bindings;
    volumeSizes = parsed.volumeSizes;
  }

  return {
    ok: true,
    value: {
      mode: "multipass",
      common: (sections.get("Common") ?? []).join("\n").trim(),
      passes,
      bindings,
      displayPass,
      volumeSizes,
    },
  };
}
