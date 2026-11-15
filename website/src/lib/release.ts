/**
 * 发布元数据：版本号、安装包列表。
 *
 * 数据由 `scripts/sync-release.mjs` 在构建前生成到 `src/data/release.json`：
 * - CI 里带 token 查 GitHub Release，拿到真实的安装包文件名；
 * - 本地构建没有这个文件时，退化为读取仓库根 package.json 的版本号，
 *   hasRelease 为 false，页面只显示「前往 Release 页面」，不将源码版本展示为发布版本。
 *
 * 可选元数据在构建期通过 glob 载入，避免打包后 import.meta.url 的路径变化，也允许文件缺失。
 */
import appPackage from "../../../package.json";

export interface ReleaseAsset {
  name: string;
  size: number;
  url: string;
  downloads: number;
  key: "windows-msi" | "windows-exe" | "zip" | "other";
  label: string;
  hint: string;
}

export interface ReleaseInfo {
  version: string;
  tag: string;
  name: string;
  publishedAt: string;
  notesUrl: string;
  downloadUrl: string;
  assets: ReleaseAsset[];
  hasRelease: boolean;
  source: string;
  generatedAt: string;
}

const generated = Object.values(
  import.meta.glob<ReleaseInfo>("../data/release.json", { eager: true, import: "default" }),
)[0];
const version = appPackage.version;

export const release: ReleaseInfo = generated ?? {
  version,
  tag: `v${version}`,
  name: "",
  publishedAt: "",
  notesUrl: "https://github.com/Lull-Desktop/Lull/releases/latest",
  downloadUrl: "https://github.com/Lull-Desktop/Lull/releases/latest",
  assets: [],
  hasRelease: false,
  source: "none",
  generatedAt: "",
};

/** 字节数转成人看的体积 */
export function formatSize(bytes: number): string {
  if (!bytes) return "";
  const mb = bytes / 1024 / 1024;
  return mb >= 1 ? `${mb.toFixed(1)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`;
}

/** 2026-10-23T10:00:00Z -> 2026-10-23 */
export function formatDate(iso: string): string {
  if (!iso) return "";
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return date.toISOString().slice(0, 10);
}
