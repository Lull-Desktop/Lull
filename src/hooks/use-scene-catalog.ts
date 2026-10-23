"use client";

/**
 * 场景目录 hook：内置场景同步可用，随包内容目录与用户内容包异步追加。
 *
 * 三条来源的优先级：内置 > 随包内容目录（已签名）> 用户安装。
 * 目录加载失败不会影响内置场景——这是“内容可选”的底线；
 * 单个内容包的错误只记入 `issues`，不会连坐其它包。
 */
import { listen } from "@tauri-apps/api/event";
import { useEffect, useMemo, useState } from "react";
import { loadContentSceneEntries } from "@/content/catalog";
import {
  listUserContentPackages,
  toUserSceneEntries,
} from "@/content/user-content";
import { isDesktopWindow } from "@/core/window/controls";
import { SCENE_HOST_PLATFORM } from "@/scenes/frame";
import { builtinCatalogEntries } from "@/scenes/registry";
import {
  isSceneCompatible,
  SCENE_HOST_API,
  type SceneCatalogEntry,
} from "@/sdk/scene";

export type SceneCatalogState = {
  entries: SceneCatalogEntry[];
  /** 随包目录整体不可用时的原因；内置场景与用户内容包仍可正常使用。 */
  error: string | null;
  /** 单个内容包被跳过 / 未签名 / 未校验等可恢复问题，逐条展示。 */
  issues: string[];
};

export function useSceneCatalog(): SceneCatalogState {
  const [builtin] = useState<SceneCatalogEntry[]>(() =>
    builtinCatalogEntries(),
  );
  const [external, setExternal] = useState<SceneCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    const builtinIds = new Set(builtin.map((entry) => entry.manifest.id));

    const load = async (): Promise<void> => {
      const collected: SceneCatalogEntry[] = [];
      const messages: string[] = [];

      try {
        const result = await loadContentSceneEntries();
        for (const issue of result.issues) messages.push(issue.message);
        if (result.signature === "missing") {
          messages.push("内容目录未签名：无法校验内容包来源");
        }
        for (const entry of result.entries) {
          if (builtinIds.has(entry.manifest.id)) {
            messages.push(
              `内容包 ${entry.manifest.id} 与内置场景同 id，已按内置优先跳过`,
            );
            continue;
          }
          collected.push(entry);
        }
        if (alive) setError(null);
      } catch (reason) {
        if (alive) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      }

      try {
        const user = toUserSceneEntries(await listUserContentPackages());
        messages.push(...user.issues);
        collected.push(...user.entries);
      } catch (reason) {
        messages.push(
          `读取用户内容包失败：${reason instanceof Error ? reason.message : String(reason)}`,
        );
      }

      if (!alive) return;
      setExternal(collected);
      setIssues([...new Set(messages)]);
    };

    void load();

    // 安装 / 卸载后刷新场景列表（设置页与壁纸窗都跑这个 hook）。
    let stop: (() => void) | null = null;
    let disposed = false;
    if (isDesktopWindow()) {
      void listen("content-changed", () => {
        void load();
      })
        .then((unlisten) => {
          if (disposed) unlisten();
          else stop = unlisten;
        })
        .catch(() => {
          // 事件通道不可用不影响首屏：安装后仍有刷新按钮。
        });
    }

    return () => {
      alive = false;
      disposed = true;
      stop?.();
    };
  }, [builtin]);

  const entries = useMemo(() => {
    const all = [...builtin, ...external].filter((entry) =>
      isSceneCompatible(entry.manifest, SCENE_HOST_API, SCENE_HOST_PLATFORM),
    );
    // 同 id 时按上面的优先级保留先出现的那条。
    const seen = new Set<string>();
    return all.filter((entry) => {
      if (seen.has(entry.manifest.id)) return false;
      seen.add(entry.manifest.id);
      return true;
    });
  }, [builtin, external]);

  return { entries, error, issues };
}
