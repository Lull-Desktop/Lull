"use client";

/**
 * 场景目录 hook：内置场景同步可用，外部内容包在目录加载并验签后追加。
 * 目录加载失败不会影响内置场景——这是“内容可选”的底线；
 * 单个内容包的错误只记入 `issues`，不会连坐其它包。
 */
import { useEffect, useMemo, useState } from "react";
import { loadContentSceneEntries } from "@/content/catalog";
import { SCENE_HOST_PLATFORM } from "@/scenes/frame";
import { builtinCatalogEntries } from "@/scenes/registry";
import {
  isSceneCompatible,
  SCENE_HOST_API,
  type SceneCatalogEntry,
} from "@/sdk/scene";

export type SceneCatalogState = {
  entries: SceneCatalogEntry[];
  /** 外部目录整体不可用时的原因；内置场景仍可正常使用。 */
  error: string | null;
  /** 单个内容包被跳过 / 目录未签名等可恢复问题，逐条展示。 */
  issues: string[];
};

export function useSceneCatalog(): SceneCatalogState {
  const [external, setExternal] = useState<SceneCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [issues, setIssues] = useState<string[]>([]);

  useEffect(() => {
    let alive = true;
    void loadContentSceneEntries()
      .then((result) => {
        if (!alive) return;
        const builtinIds = new Set(
          builtinCatalogEntries().map((entry) => entry.manifest.id),
        );
        const messages = result.issues.map((issue) => issue.message);
        for (const entry of result.entries) {
          if (builtinIds.has(entry.manifest.id)) {
            messages.push(
              `内容包 ${entry.manifest.id} 与内置场景同 id，已按内置优先跳过`,
            );
          }
        }
        if (result.signature === "missing") {
          messages.push("内容目录未签名：无法校验内容包来源");
        }
        setExternal(result.entries);
        setIssues([...new Set(messages)]);
      })
      .catch((reason: unknown) => {
        if (alive) {
          setError(reason instanceof Error ? reason.message : String(reason));
        }
      });
    return () => {
      alive = false;
    };
  }, []);

  const entries = useMemo(() => {
    const all = [...builtinCatalogEntries(), ...external].filter((entry) =>
      isSceneCompatible(entry.manifest, SCENE_HOST_API, SCENE_HOST_PLATFORM),
    );
    // 同 id 时内置场景优先，避免外部内容覆盖官方 id。
    const seen = new Set<string>();
    return all.filter((entry) => {
      if (seen.has(entry.manifest.id)) return false;
      seen.add(entry.manifest.id);
      return true;
    });
  }, [external]);

  return { entries, error, issues };
}
