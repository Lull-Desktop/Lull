/**
 * 发布元数据：版本号、安装包列表。
 *
 * 数据由 `scripts/sync-release.mjs` 在构建前生成到 `src/data/release.json`：
 * - CI 里带 token 查 GitHub Release，拿到真实的安装包文件名；
 * - 本地构建没有这个文件时，退化为读取仓库根 package.json 的版本号，
 *   页面上显示「前往 Release 页面」而不是一个猜出来的死链。
 *
 * 页面只认这里的类型，不直接 import JSON，避免文件缺失时整个构建失败。
 */
import { existsSync, readFileSync } from "node:fs";

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

function readJson(url: URL): unknown {
  try {
    if (!existsSync(url)) return null;
    return JSON.parse(readFileSync(url, "utf8"));
  } catch {
    return null;
  }
}

function repoVersion(): string {
  for (const path of ["../../../package.json", "../../../src-tauri/tauri.conf.json"]) {
    const json = readJson(new URL(path, import.meta.url)) as { version?: string } | null;
    if (json?.version) return json.version;
  }
  return "0.0.0";
}

const generated = readJson(new URL("../data/release.json", import.meta.url)) as ReleaseInfo | null;
const version = generated?.version ?? repoVersion();

export const release: ReleaseInfo = generated ?? {
  version,
  tag: `v${version}`,
  name: "",
  publishedAt: "",
  notesUrl: "https://github.com/Lull-Desktop/Lull/releases",
  downloadUrl: "https://github.com/Lull-Desktop/Lull/releases",
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
