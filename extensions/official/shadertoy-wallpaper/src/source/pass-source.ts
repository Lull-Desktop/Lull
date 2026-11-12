/**
 * Shadertoy 多 Pass 源码解析（RFC §6.1）。
 *
 * 单 Pass 源码保持原样；多 Pass 用行注释分节，代码本体不改：
 *
 * ```glsl
 * //---- Common ----
 * //---- Buffer A ----
 * //---- Buffer B ----
 * //---- Image ----
 * //---- Bindings ----
 * Image.iChannel0 = BufferA
 * ```
 *
 * 只有出现分节标记时才进入多 Pass 模式；Bindings 是运行配置，不是 GLSL。
 */
import { diagnostic, type ShaderDiagnostic } from "../runtime/diagnostics";
import { MAX_SOURCE_CHARS } from "./source-model";
import { normalizeSource } from "./source-profile";

export type ScenePassName =
  | "BufferA"
  | "BufferB"
  | "BufferC"
  | "BufferD"
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
  passes: ParsedPass[];
  bindings: PassBindings;
};

export type PassParseResult =
  | { ok: true; value: ParsedPassSource }
  | { ok: false; diagnostic: ShaderDiagnostic };

type ParseFailure = { ok: false; diagnostic: ShaderDiagnostic };

const SECTION =
  /^[ \t]*\/\/[ \t]*[-=]{2,}[ \t]*(Common|Buffer[ \t]*[A-D]|Image|Bindings)[ \t]*[-=]{2,}[ \t]*$/i;
const BINDING =
  /^[ \t]*(Buffer[ \t]*[A-D]|Image)[ \t]*\.[ \t]*iChannel([0-3])[ \t]*=[ \t]*(Buffer[ \t]*[A-D]|Image|Noise|Black)[ \t]*$/i;
const BUFFER_NAMES: ScenePassName[] = [
  "BufferA",
  "BufferB",
  "BufferC",
  "BufferD",
];

function normalizeName(raw: string): SectionName | null {
  const compact = raw.replace(/\s+/g, "").toLowerCase();
  if (compact === "common") return "Common";
  if (compact === "bindings") return "Bindings";
  if (compact === "image") return "Image";
  const buffer = /^buffer([a-d])$/.exec(compact);
  if (buffer?.[1]) {
    return `Buffer${buffer[1].toUpperCase()}` as ScenePassName;
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
): { ok: true; bindings: PassBindings } | ParseFailure {
  const bindings: PassBindings = {};
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed === "" || trimmed.startsWith("//")) continue;
    const match = BINDING.exec(trimmed);
    if (!match) {
      return fail(
        `无法解析通道绑定：${trimmed}。格式应为 Image.iChannel0 = BufferA。 / Invalid channel binding.`,
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
  return { ok: true, bindings };
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
    const marker = SECTION.exec(line);
    if (marker) {
      sawMarker = true;
      const name = normalizeName(marker[1] ?? "");
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
      },
    };
  }

  if (preamble.some((line) => line.trim() !== "")) {
    return fail(
      "多 Pass 模式下，第一个分节标记之前不能有代码。 / Code before the first pass marker is not allowed.",
    );
  }

  const image = sections.get("Image");
  if (!image) {
    return fail(
      "多 Pass 源码缺少 Image 分节。 / Multi-pass source is missing the Image section.",
    );
  }

  const passes: ParsedPass[] = [];
  for (const name of BUFFER_NAMES) {
    const content = sections.get(name);
    if (!content) continue;
    const body = content.join("\n").trim();
    if (body === "")
      return fail(`${name} 分节为空。 / ${name} section is empty.`);
    passes.push({ name, source: body });
  }
  const imageSource = image.join("\n").trim();
  if (imageSource === "") {
    return fail("Image 分节为空。 / The Image section is empty.");
  }
  passes.push({ name: "Image", source: imageSource });

  const passNames = new Set(passes.map((pass) => pass.name));
  const bindingsSection = sections.get("Bindings");
  let bindings: PassBindings = {};
  if (bindingsSection) {
    const parsed = parseBindings(bindingsSection, passNames);
    if (!parsed.ok) return parsed;
    bindings = parsed.bindings;
  }

  return {
    ok: true,
    value: {
      mode: "multipass",
      common: (sections.get("Common") ?? []).join("\n").trim(),
      passes,
      bindings,
    },
  };
}
