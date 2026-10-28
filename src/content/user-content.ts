/**
 * 用户内容包：Rust 侧扫描 `%APPDATA%\app.lull.desktop\content\` 后返回，
 * 前端再按与内置目录**同一套** `parseSceneManifest()` 校验，转成目录条目。
 *
 * 为什么不在这里做路径/摘要判断：安装与摘要复核发生在 Rust 侧（有文件系统访问权），
 * 前端只负责「这条清单能不能渲染」。两侧各管一层，避免规则漂移。
 */
import { invoke } from "@tauri-apps/api/core";
import { isDesktopWindow } from "@/core/window/controls";
import type { SignatureInfo } from "@/lib/extensions";
import { parseSceneManifest, type SceneCatalogEntry } from "@/sdk/scene";

/** 与 Rust `ContentPackageInfo` 字段一一对应（camelCase）。 */
export type UserContentPackage = {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  author?: string | null;
  license?: string | null;
  /** `ready` 可用 / `invalid` 清单不可用 / `tampered` 摘要不匹配。 */
  status: "ready" | "invalid" | "tampered";
  error?: string | null;
  entryUrl: string;
  /** 是否通过整包摘要校验；手动放置且未声明摘要的包为 false。 */
  verified: boolean;
  /** 社区发布者签名状态；与摘要校验是两条独立的链。 */
  signature: SignatureInfo;
  /** 单条 scene 清单原文；`invalid` 时为 null。 */
  manifest: unknown;
};

/** 拉取已安装内容包；非桌面环境（浏览器预览 / 测试）返回空列表。 */
export async function listUserContentPackages(): Promise<UserContentPackage[]> {
  if (!isDesktopWindow()) return [];
  const packages = await invoke<UserContentPackage[]>("content_packages");
  return Array.isArray(packages) ? packages : [];
}

export type UserContentResult = {
  entries: SceneCatalogEntry[];
  /** 被跳过或需要提示的问题，逐条展示在设置页。 */
  issues: string[];
};

/** 把用户包收敛成目录条目；坏包只影响自己。 */
export function toUserSceneEntries(
  packages: readonly UserContentPackage[],
): UserContentResult {
  const entries: SceneCatalogEntry[] = [];
  const issues: string[] = [];

  for (const pkg of packages) {
    if (pkg.status === "invalid") {
      issues.push(`内容包 ${pkg.id} 清单不可用：${pkg.error ?? "未知错误"}`);
      continue;
    }
    if (pkg.status === "tampered") {
      issues.push(
        `内容包 ${pkg.id} 摘要不匹配，已跳过：${pkg.error ?? "内容可能被改动"}`,
      );
      continue;
    }
    if (pkg.signature.decision === "block") {
      issues.push(
        `内容包 ${pkg.id} 的发布签名未通过（${pkg.signature.reason ?? pkg.signature.status}），已跳过`,
      );
      continue;
    }
    if (pkg.signature.status !== "verified") {
      issues.push(
        `内容包 ${pkg.id} 未验签（${pkg.signature.status}）：不能确认它由 community 发布`,
      );
    }
    if (!pkg.verified) {
      issues.push(`内容包 ${pkg.id} 未声明或未通过摘要校验，来源无法确认`);
    }
    if (!pkg.entryUrl) {
      issues.push(`内容包 ${pkg.id} 缺少入口地址，已跳过`);
      continue;
    }
    try {
      const manifest = parseSceneManifest(pkg.manifest, {
        requireEntry: true,
        where: `内容包 ${pkg.id}`,
      });
      entries.push({
        manifest,
        source: "user",
        entryUrl: pkg.entryUrl,
        component: null,
      });
    } catch (error) {
      issues.push(
        `内容包 ${pkg.id} 清单不合法：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  return { entries, issues };
}
