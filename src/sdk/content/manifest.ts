/**
 * 内容包通用清单：场景、主题、声景预设、桌面布局共享的元数据外壳。
 *
 * 场景包的字段校验见 `src/sdk/scene/manifest.ts`；这里只定义跨类型的公共契约，
 * 供未来的内容目录、安装器与验证工具复用。
 */
export const CONTENT_SCHEMA_VERSION = 1 as const;

export const CONTENT_TYPES = [
  "scene",
  "theme",
  "sound-preset",
  "layout",
] as const;

export type ContentType = (typeof CONTENT_TYPES)[number];

export type ContentDependency = {
  id: string;
  version: string;
};

export type ContentManifest = {
  schemaVersion: typeof CONTENT_SCHEMA_VERSION;
  type: ContentType;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license: string;
  /** 可选入口文件，相对内容包根目录。 */
  entry?: string;
  capabilities?: string[];
  dependencies?: ContentDependency[];
  /** 声明内容包兼容的宿主 API 版本。 */
  hostApi?: string;
};

const ID_PATTERN = /^[a-z0-9][a-z0-9._-]{2,63}$/;
const VERSION_PATTERN = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requireString(
  record: Record<string, unknown>,
  key: string,
  where: string,
): string {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${where}: 字段 ${key} 必须是非空字符串`);
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
    throw new Error(`${where}: 字段 ${key} 必须是非空字符串或省略`);
  }
  return value.trim();
}

/** 解析一份通用内容包清单；未知字段保留给未来版本，不在这里拒绝。 */
export function parseContentManifest(
  input: unknown,
  where = "content manifest",
): ContentManifest {
  if (!isRecord(input)) {
    throw new Error(`${where}: 必须是 JSON 对象`);
  }
  if (input.schemaVersion !== CONTENT_SCHEMA_VERSION) {
    throw new Error(
      `${where}: 不支持的 schemaVersion=${String(input.schemaVersion)}（当前支持 ${CONTENT_SCHEMA_VERSION}）`,
    );
  }
  const type = input.type;
  if (
    typeof type !== "string" ||
    !CONTENT_TYPES.includes(type as ContentType)
  ) {
    throw new Error(`${where}: 未知内容类型 ${String(type)}`);
  }
  const id = requireString(input, "id", where);
  if (!ID_PATTERN.test(id)) {
    throw new Error(`${where}: id "${id}" 非法`);
  }
  const version = requireString(input, "version", where);
  if (!VERSION_PATTERN.test(version)) {
    throw new Error(`${where}: version "${version}" 不是语义化版本`);
  }

  const capabilities = input.capabilities;
  if (capabilities !== undefined) {
    if (
      !Array.isArray(capabilities) ||
      capabilities.some((item) => typeof item !== "string" || item === "")
    ) {
      throw new Error(`${where}: capabilities 必须是非空字符串数组`);
    }
  }

  const dependenciesInput = input.dependencies;
  let dependencies: ContentDependency[] | undefined;
  if (dependenciesInput !== undefined) {
    if (!Array.isArray(dependenciesInput)) {
      throw new Error(`${where}: dependencies 必须是数组`);
    }
    dependencies = dependenciesInput.map((raw, index) => {
      if (!isRecord(raw)) {
        throw new Error(`${where}: dependencies[${index}] 必须是对象`);
      }
      return {
        id: requireString(raw, "id", `${where}.dependencies[${index}]`),
        version: requireString(
          raw,
          "version",
          `${where}.dependencies[${index}]`,
        ),
      };
    });
  }

  return {
    schemaVersion: CONTENT_SCHEMA_VERSION,
    type: type as ContentType,
    id,
    name: requireString(input, "name", where),
    version,
    description: optionalString(input, "description", where),
    author: optionalString(input, "author", where),
    license: requireString(input, "license", where),
    entry: optionalString(input, "entry", where),
    capabilities: Array.isArray(capabilities)
      ? capabilities.map((item) => String(item))
      : undefined,
    dependencies,
    hostApi: optionalString(input, "hostApi", where),
  };
}
