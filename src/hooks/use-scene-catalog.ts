"use client";

/**
 * 场景目录 hook：内置场景同步可用，外部内容包在目录加载完成后追加。
 * 目录加载失败不会影响内置场景——这是“内容可选”的底线。
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
  /** 外部目录加载失败时的原因；内置场景仍可正常使用。 */
  error: string | null;
};

export function useSceneCatalog(): SceneCatalogState {
  const [external, setExternal] = useState<SceneCatalogEntry[]>([]);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void loadContentSceneEntries()
      .then((entries) => {
        if (alive) setExternal(entries);
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

  return { entries, error };
}
