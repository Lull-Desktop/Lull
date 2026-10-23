#!/usr/bin/env node
/**
 * 生成网站用的发布元数据：website/src/data/release.json
 *
 * 为什么要有这一步：下载页的版本号与文件名不写死在任何页面里。
 * - 版本号的唯一事实源是仓库根 `package.json`（与 `src-tauri/tauri.conf.json` 同值）。
 * - 安装包文件名只有 GitHub Release 上才有，构建时向 GitHub API 查最新 release，
 *   查不到（还没有发布过 / 网络不通 / fork 上没有 token）就退化成「去 Release 页面下载」。
 *
 * 用法：
 *   node scripts/sync-release.mjs             # 查 GitHub API（有 GITHUB_TOKEN 就用）
 *   node scripts/sync-release.mjs --offline   # 不联网，只用仓库里的版本号
 *
 * 这个脚本永不因网络问题让构建失败：任何异常都退化成兜底数据。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const websiteRoot = resolve(here, "..");
const repoRoot = resolve(websiteRoot, "..");
const outFile = resolve(websiteRoot, "src/data/release.json");

const offline = process.argv.includes("--offline");
const repo = process.env.GITHUB_REPOSITORY ?? "Lull-Desktop/Lull";
const token = process.env.GITHUB_TOKEN ?? process.env.GH_TOKEN ?? "";

/** 从仓库里读版本号，读不到就给一个明确占位，避免页面出现 undefined */
function readRepoVersion() {
  const candidates = [
    resolve(repoRoot, "package.json"),
    resolve(repoRoot, "src-tauri/tauri.conf.json"),
  ];
  for (const file of candidates) {
    try {
      const json = JSON.parse(readFileSync(file, "utf8"));
      if (typeof json.version === "string" && json.version) return json.version;
    } catch {
      // 换下一个来源
    }
  }
  return "0.0.0";
}

/** 安装包文件名 -> 用户能看懂的平台标签 */
function platformOf(assetName) {
  const name = assetName.toLowerCase();
  if (name.endsWith(".msi")) return { key: "windows-msi", label: "Windows 安装包 (.msi)", hint: "推荐" };
  if (name.endsWith(".exe")) return { key: "windows-exe", label: "Windows 安装包 (.exe)", hint: "" };
  if (name.endsWith(".zip")) return { key: "zip", label: "压缩包 (.zip)", hint: "免安装" };
  return { key: "other", label: "其他文件", hint: "" };
}

const version = readRepoVersion();
const releasesUrl = `https://github.com/${repo}/releases`;
const latestUrl = `${releasesUrl}/latest`;

let payload = {
  version,
  tag: `v${version}`,
  name: "",
  publishedAt: "",
  notesUrl: "",
  downloadUrl: latestUrl,
  assets: [],
  /** GitHub 上是否真的存在可下载的 release；false 时页面显示「尚未发布」而不是死链 */
  hasRelease: false,
  /** 元数据来源：github-api / offline / fallback */
  source: offline ? "offline" : "fallback",
  generatedAt: new Date().toISOString(),
};

async function fetchLatestRelease() {
  const res = await fetch(`https://api.github.com/repos/${repo}/releases/latest`, {
    headers: {
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "lull-website-build",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    signal: AbortSignal.timeout(10_000),
  });

  // 404 = 这个仓库还没有正式 release，属于正常状态
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub API ${res.status} ${res.statusText}`);
  return res.json();
}

if (!offline) {
  try {
    const release = await fetchLatestRelease();
    if (release && !release.draft) {
      const assets = (release.assets ?? [])
        .filter((asset) => asset.state === "uploaded")
        .map((asset) => ({
          name: asset.name,
          size: asset.size,
          url: asset.browser_download_url,
          downloads: asset.download_count ?? 0,
          ...platformOf(asset.name),
        }))
        // .msi / .exe 排在 .zip 前面
        .sort((a, b) => {
          const rank = { "windows-msi": 0, "windows-exe": 1, zip: 2, other: 3 };
          return rank[a.key] - rank[b.key];
        });

      const tag = release.tag_name ?? `v${version}`;
      payload = {
        ...payload,
        // release 上的 tag 才是已发布的真实版本，优先于仓库里的 package.json
        version: tag.replace(/^v/, ""),
        tag,
        name: release.name ?? tag,
        publishedAt: release.published_at ?? "",
        notesUrl: release.html_url ?? latestUrl,
        downloadUrl: release.html_url ?? latestUrl,
        assets,
        hasRelease: true,
        source: "github-api",
      };
      console.log(`[release] ${repo} 最新发布 ${tag}，${assets.length} 个文件`);
    } else {
      console.log(`[release] ${repo} 暂无 release，使用仓库版本 v${version}`);
    }
  } catch (error) {
    console.warn(`[release] 拉取 GitHub release 失败，使用兜底数据：${error.message}`);
  }
} else {
  console.log(`[release] --offline，使用仓库版本 v${version}`);
}

mkdirSync(dirname(outFile), { recursive: true });
writeFileSync(outFile, `${JSON.stringify(payload, null, 2)}\n`, "utf8");
console.log(`[release] 已写入 ${outFile.replace(repoRoot, ".")}`);
