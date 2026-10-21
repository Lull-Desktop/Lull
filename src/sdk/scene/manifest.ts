/**
 * Scene Manifest：场景包对宿主的最小契约。
 *
 * 设计原则：字段少而稳定、未知字段直接拒绝（早期发现拼写错误），
 * 内置场景与社区静态内容包共用同一份清单格式。
 */

export const SCENE_SCHEMA_VERSION = 1 as const;

export const SCENE_CAPABILITIES = [
  "wallpaper.viewport",
  "wallpaper.canvas",
  "wallpaper.sync",
] as const;

export type SceneCapability = (typeof SCENE_CAPABILITIES)[number];

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
    const background = themeInput.background;
    const accent = themeInput.accent;
    if (
      background !== undefined &&
      (typeof background !== "string" || background.trim() === "")
    ) {
      fail(where, "theme.background 必须是非空字符串或省略");
    }
    if (
      accent !== undefined &&
      (typeof accent !== "string" || accent.trim() === "")
    ) {
      fail(where, "theme.accent 必须是非空字符串或省略");
    }
    theme = {
      background:
        typeof background === "string" ? background.trim() : undefined,
      accent: typeof accent === "string" ? accent.trim() : undefined,
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
  };
}
