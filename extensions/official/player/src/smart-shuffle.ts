/**
 * 智能随机的展示辅助：内置配置文案。
 *
 * Profile 列表/配置由 Rust Media Service 提供；这里不再保存 preset 数值。
 */
export const BUILTIN_PROFILE_COPY: Record<
  string,
  { label: string; description: string }
> = {
  "builtin:balanced": {
    label: "均衡随机",
    description: "兼顾随机性、曲风多样性和歌曲间隔。",
  },
  "builtin:random": {
    label: "高度随机",
    description: "减少约束，让曲库中的歌曲更均匀地出现。",
  },
  "builtin:diverse": {
    label: "多样性优先",
    description: "尽量避免连续听到相同歌手、专辑和曲风。",
  },
};

export function profileDescription(profileId: string): string {
  return BUILTIN_PROFILE_COPY[profileId]?.description ?? "自定义听感参数。";
}
