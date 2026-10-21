"use client";

/**
 * 场景目录 hook：内置场景同步可用，外部内容包在目录加载完成后追加。
 * 目录加载失败不会影响内置场景——这是“内容可选”的底线。
 */
import { useEffect, useMemo, useState } from "react";
import { loadContentSceneEntries } from "@/content/catalog";
import { builtinCatalogEntries } from "@/scenes/registry";
import type { SceneCatalogEntry } from "@/sdk/scene";

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

  const entries = useMemo(
    () => [...builtinCatalogEntries(), ...external],
    [external],
  );

  return { entries, error };
}
