// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package
"use client";
import type {
  LullMediaClient,
  NoiseAsset,
  NoiseCategory,
} from "@lull/media-sdk";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { m } from "@/paraglide/messages";

export type AssetState = {
  status: "loading" | "failed" | "missing" | "available";
  asset?: NoiseAsset;
};
export function useEnvironmentAssets(
  client: LullMediaClient | null,
  ids: string[],
  version: number,
  active: boolean,
) {
  const key = JSON.stringify([...new Set(ids.filter(Boolean))].sort());
  const [states, setStates] = useState<Record<string, AssetState>>({});
  const cache = useRef<{
    client: LullMediaClient | null;
    version: number;
    assets: Record<string, AssetState>;
  }>({ client, version, assets: {} });
  useEffect(() => {
    if (!active || !client) return;
    let alive = true;
    if (cache.current.client !== client || cache.current.version !== version)
      cache.current = { client, version, assets: {} };
    const selected = JSON.parse(key) as string[];
    const cached = cache.current.assets;
    setStates(
      Object.fromEntries(
        selected.map((id) => [id, cached[id] ?? { status: "loading" }]),
      ),
    );
    for (const id of selected) {
      if (cached[id]) continue;
      void client.noise.library
        .getAsset(id)
        .then(
          (asset) =>
            ({
              asset,
              status: asset.status === "available" ? "available" : "missing",
            }) as AssetState,
        )
        .catch(
          (error: unknown): AssetState => ({
            status:
              typeof error === "object" &&
              error !== null &&
              "code" in error &&
              error.code === "noise.asset.not-found"
                ? "missing"
                : "failed",
          }),
        )
        .then((result) => {
          if (!alive) return;
          cached[id] = result;
          setStates((previous) => ({ ...previous, [id]: result }));
        });
    }
    return () => {
      alive = false;
    };
  }, [client, key, version, active]);
  // An invalidated cache must not expose stale availability during the next effect.
  return cache.current.client === client && cache.current.version === version
    ? states
    : {};
}

export function EnvironmentAssetPicker({
  client,
  version,
  onSelect,
  onClose,
}: {
  client: LullMediaClient;
  version: number;
  onSelect: (asset: NoiseAsset) => void;
  onClose: () => void;
}) {
  const id = useId();
  const searchRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    searchRef.current?.focus();
  }, []);
  const [keyword, setKeyword] = useState("");
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState("all");
  const [categories, setCategories] = useState<NoiseCategory[]>([]);
  const [categoryError, setCategoryError] = useState(false);
  const [page, setPage] = useState(1);
  const [assets, setAssets] = useState<NoiseAsset[]>([]);
  const [hasMore, setHasMore] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [retry, setRetry] = useState(0);
  useEffect(() => {
    if (keyword.trim() === query) return;
    const timer = window.setTimeout(() => {
      setQuery(keyword.trim());
      setPage(1);
    }, 250);
    return () => window.clearTimeout(timer);
  }, [keyword, query]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry and version refresh library metadata.
  useEffect(() => {
    let alive = true;
    setCategoryError(false);
    void client.noise.library
      .getCategories()
      .then((value) => {
        if (alive) setCategories(value);
      })
      .catch(() => {
        if (alive) setCategoryError(true);
      });
    return () => {
      alive = false;
    };
  }, [client, retry, version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: a library update invalidates all loaded pages.
  useEffect(() => {
    setPage(1);
  }, [version]);
  // biome-ignore lint/correctness/useExhaustiveDependencies: retry and version explicitly invalidate the query.
  useEffect(() => {
    let alive = true;
    setLoading(true);
    setError(false);
    if (page === 1) setAssets([]);
    void client.noise.library
      .listAssets({
        keyword: query || undefined,
        categoryId: category === "all" ? undefined : category,
        status: "available",
        page,
        pageSize: 50,
        sortBy: "name",
        sortOrder: "asc",
      })
      .then((result) => {
        if (!alive) return;
        setAssets((previous) =>
          page === 1
            ? result.items
            : [
                ...new Map(
                  [...previous, ...result.items].map((asset) => [
                    asset.id,
                    asset,
                  ]),
                ).values(),
              ],
        );
        setHasMore(result.hasMore);
      })
      .catch(() => {
        if (alive) setError(true);
      })
      .finally(() => {
        if (alive) setLoading(false);
      });
    return () => {
      alive = false;
    };
  }, [client, query, category, page, version, retry]);
  return (
    <section
      aria-label={m.env_pick()}
      className="space-y-2 rounded-md border border-border bg-background p-3"
    >
      <div className="flex flex-wrap items-end gap-2">
        <label
          htmlFor={`${id}-search`}
          className="min-w-0 basis-full text-xs sm:flex-1 sm:basis-48"
        >
          {m.env_search()}
          <input
            id={`${id}-search`}
            ref={searchRef}
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
            className="mt-1 h-8 w-full rounded-md border border-input bg-background px-2"
          />
        </label>
        <Select
          value={category}
          onValueChange={(value) => {
            setCategory(value);
            setPage(1);
          }}
        >
          <SelectTrigger
            aria-label={m.env_category()}
            size="sm"
            className="max-w-full"
          >
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectItem value="all">{m.env_all_categories()}</SelectItem>
            {categories.map((item) => (
              <SelectItem key={item.id} value={item.id}>
                {item.name}
              </SelectItem>
            ))}
          </SelectContent>
        </Select>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          {m.env_picker_close()}
        </Button>
      </div>
      {(error || categoryError) && (
        <p role="alert">
          {m.env_load_failed()}{" "}
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={() => setRetry((v) => v + 1)}
          >
            {m.env_retry()}
          </Button>
        </p>
      )}
      <div className="max-h-48 space-y-1 overflow-y-auto" aria-busy={loading}>
        {assets.map((asset) => (
          <Button
            type="button"
            key={asset.id}
            size="sm"
            variant="ghost"
            className="h-auto w-full justify-start whitespace-normal break-words text-left"
            onClick={() => onSelect(asset)}
          >
            {asset.name}
          </Button>
        ))}
        {loading && <output>{m.env_loading()}</output>}
        {!loading && !error && assets.length === 0 && (
          <p>{m.env_no_assets()}</p>
        )}
      </div>
      {hasMore && !error && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={loading}
          onClick={() => {
            setLoading(true);
            setPage((v) => v + 1);
          }}
        >
          {m.env_more()}
        </Button>
      )}
    </section>
  );
}
