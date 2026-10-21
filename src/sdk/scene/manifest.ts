/**
 * Scene Manifest：场景包对宿主的最小契约。
 *
 * 设计原则：字段少而稳定、未知字段直接拒绝（早期发现拼写错误），
 * 内置场景与社区静态内容包共用同一份清单格式。
 */

export const SCENE_SCHEMA_VERSION = 1 as const;

/** 宿主 API 版本：清单里的 compatibility.hostApi 与它比较。破坏性变更才递增。 */
export const SCENE_HOST_API = 1 as const;

export const SCENE_CAPABILITIES = [
  "wallpaper.viewport",
  "wallpaper.canvas",
  "wallpaper.sync",
] as const;

export type SceneCapability = (typeof SCENE_CAPABILITIES)[number];

export const SCENE_PLATFORMS = ["windows", "macos", "linux"] as const;
export type ScenePlatform = (typeof SCENE_PLATFORMS)[number];

export const SCENE_PARAM_TYPES = [
  "number",
  "boolean",
  "string",
  "color",
  "enum",
] as const;
export type SceneParamType = (typeof SCENE_PARAM_TYPES)[number];

export type SceneParamOption = {
  value: string;
  label: string;
};

/** 场景可选参数：宿主按类型校验、应用默认值，并把值传给场景。 */
export type SceneParamDefinition = {
  key: string;
  type: SceneParamType;
  label: string;
  description?: string;
  default: string | number | boolean;
  /** number 类型可用。 */
  min?: number;
  max?: number;
  step?: number;
  /** enum 类型必填。 */
  options?: SceneParamOption[];
};

export type ScenePerformanceHints = {
  tier: "low" | "medium" | "high";
  targetFps?: number;
};

/** 内容包声明的宿主兼容范围；缺失时按“兼容当前宿主”处理。 */
export type SceneCompatibility = {
  hostApi: number;
  maxHostApi?: number;
  platforms?: ScenePlatform[];
};

export type SceneThemeHints = {
  /** 场景首帧背景色，用于窗口创建到首帧之间的防闪。 */
  background?: string;
  /** 场景强调色，供设置页与内容目录展示。 */
  accent?: string;
};

export type SceneManifest = {
  schemaVersion: typeof SCENE_SCHEMA_VERSION;
  type: "scene";
  /** 全局唯一、小写、建议使用 `作者.场景` 命名空间。 */
  id: string;
  /** 面向用户的显示名。 */
  name: string;
  /** 语义化版本。 */
  version: string;
  description?: string;
  author?: string;
  /** SPDX 标识或许可证名称；内容包必填。 */
  license: string;
  capabilities: SceneCapability[];
  /**
   * 静态 Web 内容入口，相对内容目录的 `.html` 路径。
   * 内置场景由源码注册，不使用该字段。
   */
  entry?: string;
  theme?: SceneThemeHints;
  params?: SceneParamDefinition[];
  performance?: ScenePerformanceHints;
  compatibility?: SceneCompatibility;
};

export type ParseSceneManifestOptions = {
  /** 内容包（外部场景）必须声明 entry；内置场景不需要。 */
  requireEntry?: boolean;
  /** 报错前缀，便于定位目录 / 文件中的具体条目。 */
  where?: string;
};

export class SceneManifestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SceneManifestError";
  }
}

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;
const SAFE_ENTRY_PATTERN =
  /^(?!\/)(?!.*(?:^|\/)\.\.(?:\/|$))[A-Za-z0-9][A-Za-z0-9._/-]*\.html$/;
const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;
const PARAM_KEY_PATTERN = /^[a-z][a-z0-9._-]{0,31}$/;
const MANIFEST_KEYS = new Set([
  "schemaVersion",
  "type",
  "id",
  "name",
  "version",
  "description",
  "author",
  "license",
  "capabilities",
  "entry",
  "theme",
  "params",
  "performance",
  "compatibility",
]);
const PERFORMANCE_TIERS = ["low", "medium", "high"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function fail(where: string, message: string): never {
  throw new SceneManifestError(`${where}: ${message}`);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    fail(where, `字段 ${key} 必须是非空字符串`);
  }
  return value.trim();
}

function optionalString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || value.trim() === "") {
    fail(where, `字段 ${key} 必须是非空字符串或省略`);
  }
  return value.trim();
}

function optionalFiniteNumber(
  record: Record<string, unknown>,
  key: string,
  where: string,
): number | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value)) {
    fail(where, `字段 ${key} 必须是有限数字或省略`);
  }
  return value;
}

function optionalColor(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" || !COLOR_PATTERN.test(value.trim())) {
    fail(where, `字段 ${key} 必须是 #RRGGBB 颜色或省略`);
  }
  return value.trim();
}

function parseSceneParams(
  value: unknown,
  where: string,
): SceneParamDefinition[] | undefined {
  if (value === undefined || value === null) return undefined;
  if (!Array.isArray(value)) fail(where, "params 必须是数组或省略");
  const out: SceneParamDefinition[] = [];
  const seen = new Set<string>();
  value.forEach((raw, index) => {
    const at = `${where}.params[${index}]`;
    if (!isRecord(raw)) fail(at, "必须是对象");
    for (const field of Object.keys(raw)) {
      if (
        ![
          "key",
          "type",
          "label",
          "description",
          "default",
          "min",
          "max",
          "step",
          "options",
        ].includes(field)
      ) {
        fail(at, `未知字段: ${field}`);
      }
    }
    const key = requireString(raw, "key", at);
    if (!PARAM_KEY_PATTERN.test(key)) {
      fail(at, `key "${key}" 非法：只允许小写字母、数字、点、下划线与连字符`);
    }
    if (seen.has(key)) fail(at, `key 重复: ${key}`);
    seen.add(key);

    const type = requireString(raw, "type", at);
    if (!SCENE_PARAM_TYPES.includes(type as SceneParamType)) {
      fail(at, `未知参数类型: ${type}`);
    }
    const label = requireString(raw, "label", at);
    const description = optionalString(raw, "description", at);
    if (!("default" in raw)) fail(at, "缺少 default");
    const defaultValue = raw.default;

    const min = optionalFiniteNumber(raw, "min", at);
    const max = optionalFiniteNumber(raw, "max", at);
    const step = optionalFiniteNumber(raw, "step", at);
    let enumOptions: SceneParamOption[] | undefined;

    if (type === "number") {
      if (typeof defaultValue !== "number" || !Number.isFinite(defaultValue)) {
        fail(at, "number 参数的 default 必须是有限数字");
      }
      if (min !== undefined && max !== undefined && min > max) {
        fail(at, "min 不能大于 max");
      }
      if (step !== undefined && step <= 0) fail(at, "step 必须大于 0");
    } else if (type === "boolean") {
      if (typeof defaultValue !== "boolean") {
        fail(at, "boolean 参数的 default 必须是布尔值");
      }
    } else if (type === "color") {
      if (
        typeof defaultValue !== "string" ||
        !COLOR_PATTERN.test(defaultValue)
      ) {
        fail(at, "color 参数的 default 必须是 #RRGGBB");
      }
    } else if (type === "enum") {
      if (!Array.isArray(raw.options) || raw.options.length === 0) {
        fail(at, "enum 参数必须提供非空 options");
      }
      const options: SceneParamOption[] = [];
      const values = new Set<string>();
      raw.options.forEach((option, optionIndex) => {
        const optionAt = `${at}.options[${optionIndex}]`;
        if (!isRecord(option)) fail(optionAt, "必须是对象");
        for (const field of Object.keys(option)) {
          if (field !== "value" && field !== "label") {
            fail(optionAt, `未知字段: ${field}`);
          }
        }
        const optionValue = requireString(option, "value", optionAt);
        const optionLabel = requireString(option, "label", optionAt);
        if (values.has(optionValue)) {
          fail(optionAt, `value 重复: ${optionValue}`);
        }
        values.add(optionValue);
        options.push({ value: optionValue, label: optionLabel });
      });
      if (typeof defaultValue !== "string" || !values.has(defaultValue)) {
        fail(at, "enum 参数的 default 必须命中 options.value");
      }
      enumOptions = options;
    } else if (typeof defaultValue !== "string") {
      fail(at, "string 参数的 default 必须是字符串");
    }

    if (
      type !== "number" &&
      (min !== undefined || max !== undefined || step !== undefined)
    ) {
      fail(at, "min/max/step 只适用于 number 参数");
    }
    if (type !== "enum" && raw.options !== undefined) {
      fail(at, "options 只适用于 enum 参数");
    }

    out.push({
      key,
      type: type as SceneParamType,
      label,
      description,
      default: defaultValue as string | number | boolean,
      min,
      max,
      step,
      options: enumOptions,
    });
  });
  return out;
}

function parsePerformance(
  value: unknown,
  where: string,
): ScenePerformanceHints | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail(where, "performance 必须是对象或省略");
  for (const field of Object.keys(value)) {
    if (field !== "tier" && field !== "targetFps") {
      fail(where, `performance 含未知字段: ${field}`);
    }
  }
  const tier = requireString(value, "tier", where);
  if (!PERFORMANCE_TIERS.includes(tier as ScenePerformanceHints["tier"])) {
    fail(where, `未知性能档位: ${tier}`);
  }
  const targetFps = optionalFiniteNumber(value, "targetFps", where);
  if (
    targetFps !== undefined &&
    (!Number.isInteger(targetFps) || targetFps < 1 || targetFps > 240)
  ) {
    fail(where, "performance.targetFps 必须是 1-240 的整数");
  }
  return { tier: tier as ScenePerformanceHints["tier"], targetFps };
}

function parseCompatibility(
  value: unknown,
  where: string,
): SceneCompatibility | undefined {
  if (value === undefined || value === null) return undefined;
  if (!isRecord(value)) fail(where, "compatibility 必须是对象或省略");
  for (const field of Object.keys(value)) {
    if (
      field !== "hostApi" &&
      field !== "maxHostApi" &&
      field !== "platforms"
    ) {
      fail(where, `compatibility 含未知字段: ${field}`);
    }
  }
  const hostApi = optionalFiniteNumber(value, "hostApi", where);
  if (hostApi === undefined || !Number.isInteger(hostApi) || hostApi < 1) {
    fail(where, "compatibility.hostApi 必须是正整数");
  }
  const maxHostApi = optionalFiniteNumber(value, "maxHostApi", where);
  if (
    maxHostApi !== undefined &&
    (!Number.isInteger(maxHostApi) || maxHostApi < hostApi)
  ) {
    fail(where, "compatibility.maxHostApi 必须是大于等于 hostApi 的整数");
  }
  let platforms: ScenePlatform[] | undefined;
  if (value.platforms !== undefined) {
    if (!Array.isArray(value.platforms) || value.platforms.length === 0) {
      fail(where, "compatibility.platforms 必须是非空数组或省略");
    }
    platforms = [];
    for (const raw of value.platforms) {
      if (
        typeof raw !== "string" ||
        !SCENE_PLATFORMS.includes(raw as ScenePlatform)
      ) {
        fail(where, `未知平台: ${String(raw)}`);
      }
      if (platforms.includes(raw as ScenePlatform)) {
        fail(where, `平台重复: ${raw}`);
      }
      platforms.push(raw as ScenePlatform);
    }
  }
  return { hostApi, maxHostApi, platforms };
}

/** 校验静态内容入口：必须是相对路径、不得逃逸内容根目录、必须是 .html。 */
export function isSafeContentEntry(entry: string): boolean {
  return (
    SAFE_ENTRY_PATTERN.test(entry) &&
    !entry.includes("\\") &&
    !entry.split("/").includes("..")
  );
}

/**
 * 解析并校验一份 Scene Manifest。
 * 任何不符合契约的字段都会抛出 `SceneManifestError`，调用方决定降级或拒绝整个目录。
 */
export function parseSceneManifest(
  input: unknown,
  options: ParseSceneManifestOptions = {},
): SceneManifest {
  const where = options.where ?? "scene manifest";
  if (!isRecord(input)) fail(where, "必须是 JSON 对象");
  for (const key of Object.keys(input)) {
    if (!MANIFEST_KEYS.has(key)) fail(where, `未知字段: ${key}`);
  }

  if (input.schemaVersion !== SCENE_SCHEMA_VERSION) {
    fail(
      where,
      `不支持的 schemaVersion=${String(input.schemaVersion)}（当前支持 ${SCENE_SCHEMA_VERSION}）`,
    );
  }
  if (input.type !== "scene") {
    fail(where, 'type 必须是 "scene"');
  }

  const id = requireString(input, "id", where);
  if (!ID_PATTERN.test(id)) {
    fail(where, `id "${id}" 非法：只允许小写字母、数字、点、下划线与连字符`);
  }

  const version = requireString(input, "version", where);
  if (!VERSION_PATTERN.test(version)) {
    fail(where, `version "${version}" 不是合法的语义化版本`);
  }

  const capabilityInput = input.capabilities;
  if (!Array.isArray(capabilityInput) || capabilityInput.length === 0) {
    fail(where, "capabilities 必须是非空数组");
  }
  const capabilities: SceneCapability[] = [];
  for (const raw of capabilityInput) {
    if (
      typeof raw !== "string" ||
      !SCENE_CAPABILITIES.includes(raw as SceneCapability)
    ) {
      fail(where, `未知 capability: ${String(raw)}`);
    }
    const capability = raw as SceneCapability;
    if (capabilities.includes(capability)) {
      fail(where, `capability 重复: ${capability}`);
    }
    capabilities.push(capability);
  }

  const entry = optionalString(input, "entry", where);
  if (options.requireEntry && !entry) {
    fail(where, "内容包场景必须声明 entry");
  }
  if (entry && !isSafeContentEntry(entry)) {
    fail(where, `entry "${entry}" 必须是内容目录内的相对 .html 路径`);
  }

  const themeInput = input.theme;
  let theme: SceneThemeHints | undefined;
  if (themeInput !== undefined && themeInput !== null) {
    if (!isRecord(themeInput)) fail(where, "theme 必须是对象");
    theme = {
      background: optionalColor(themeInput, "background", where),
      accent: optionalColor(themeInput, "accent", where),
    };
  }

  return {
    schemaVersion: SCENE_SCHEMA_VERSION,
    type: "scene",
    id,
    name: requireString(input, "name", where),
    version,
    description: optionalString(input, "description", where),
    author: optionalString(input, "author", where),
    license: requireString(input, "license", where),
    capabilities,
    entry,
    theme,
    params: parseSceneParams(input.params, where),
    performance: parsePerformance(input.performance, where),
    compatibility: parseCompatibility(input.compatibility, where),
  };
}
