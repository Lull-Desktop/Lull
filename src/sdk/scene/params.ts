/**
 * 场景参数解析：把配置里的字符串值按 Manifest 声明的类型还原，
 * 缺失或非法值回退到默认值，number 自动限制在 min/max 内。
 */
import type { SceneParamDefinition } from "./manifest";

export type SceneParamValue = string | number | boolean;

const COLOR_PATTERN = /^#[0-9A-Fa-f]{6}$/;

function coerce(
  def: SceneParamDefinition,
  raw: string | undefined,
): SceneParamValue {
  if (def.type === "number") {
    const value =
      raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    if (!Number.isFinite(value)) return def.default as number;
    const min = def.min ?? Number.NEGATIVE_INFINITY;
    const max = def.max ?? Number.POSITIVE_INFINITY;
    return Math.min(max, Math.max(min, value));
  }
  if (def.type === "boolean") {
    if (raw === "true") return true;
    if (raw === "false") return false;
    return def.default as boolean;
  }
  if (def.type === "enum") {
    if (
      raw !== undefined &&
      def.options?.some((option) => option.value === raw)
    ) {
      return raw;
    }
    return def.default as string;
  }
  if (def.type === "color") {
    if (raw !== undefined && COLOR_PATTERN.test(raw)) return raw;
    return def.default as string;
  }
  return raw !== undefined ? raw : (def.default as string);
}

export function resolveSceneParams(
  definitions: readonly SceneParamDefinition[] | undefined,
  stored: Readonly<Record<string, string>> | undefined,
): Readonly<Record<string, SceneParamValue>> {
  const out: Record<string, SceneParamValue> = {};
  for (const def of definitions ?? []) {
    out[def.key] = coerce(def, stored?.[def.key]);
  }
  return out;
}
