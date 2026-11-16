// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
"use client";

import type { LullMediaClient, NoiseAsset, NoiseTrack } from "@lull/media-sdk";
import { useEffect, useState } from "react";

type Anchor = { assetId: string; intensity: number };

/** Edits the semantic curve belonging to one session track. */
export function NoiseEnvironmentEditor({ client, track }: {
  client: LullMediaClient | null;
  track: NoiseTrack;
}) {
  const [open, setOpen] = useState(false);
  const [assets, setAssets] = useState<NoiseAsset[]>([]);
  const [type, setType] = useState(track.environment?.type ?? "rain");
  const [anchors, setAnchors] = useState<Anchor[]>(
    track.environment?.anchors.map(({ assetId, intensity }) => ({ assetId, intensity })) ?? [
      { assetId: track.assetId, intensity: 0 },
      { assetId: "", intensity: 1 },
    ],
  );
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open || !client) return;
    let active = true;
    void (async () => {
      const result: NoiseAsset[] = [];
      for (let page = 1; ; page += 1) {
        const batch = await client.noise.library.listAssets({ page, pageSize: 200, status: "available" });
        result.push(...batch.items);
        if (!batch.hasMore) break;
      }
      if (active) setAssets(result);
    })().catch((reason: unknown) => {
      if (active) setError(reason instanceof Error ? reason.message : String(reason));
    });
    return () => { active = false; };
  }, [client, open]);

  const submit = async (): Promise<void> => {
    if (!client) return;
    setBusy(true);
    setError("");
    try {
      await client.noise.tracks.configureEnvironment(track.id, {
        type,
        intensity: track.environment?.intensity ?? 0.5,
        anchors,
      });
      setOpen(false);
    } catch (reason) {
      setError(reason instanceof Error ? reason.message : String(reason));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 md:col-span-3">
      <button type="button" className="text-xs underline" onClick={() => {
        if (!open) {
          setType(track.environment?.type ?? "rain");
          setAnchors(track.environment?.anchors.map(({ assetId, intensity }) => ({ assetId, intensity })) ?? [
            { assetId: track.assetId, intensity: 0 }, { assetId: "", intensity: 1 },
          ]);
          setError("");
        }
        setOpen(!open);
      }}>
        {open ? "收起环境配置" : track.environment ? "编辑环境配置" : "配置环境强度"}
      </button>
      {open && (
        <div className="space-y-2 rounded border border-border p-2 text-xs">
          <label className="flex items-center gap-2">
            环境类型
            <select value={type} onChange={(event) => setType(event.currentTarget.value)}>
              <option value="rain">雨</option><option value="wind">风</option>
              <option value="water">水</option><option value="fire">火</option>
              <option value="snow">雪</option><option value="lightning">雷电</option>
            </select>
          </label>
          <p>按强度从低到高选择不同的素材；强度为 0 时使用最低档素材。</p>
          {anchors.map((anchor, index) => (
            <div className="flex flex-wrap items-center gap-2" key={index}>
              <label>强度 % <input type="number" min="0" max="100" value={Math.round(anchor.intensity * 100)}
                onChange={(event) => setAnchors(anchors.map((item, i) => i === index ? { ...item, intensity: Number(event.currentTarget.value) / 100 } : item))}
                className="w-16 rounded border border-border px-1" /></label>
              <select aria-label={`第 ${index + 1} 个强度素材`} value={anchor.assetId}
                onChange={(event) => setAnchors(anchors.map((item, i) => i === index ? { ...item, assetId: event.currentTarget.value } : item))}>
                <option value="">选择素材</option>
                {anchor.assetId && !assets.some((asset) => asset.id === anchor.assetId) && <option value={anchor.assetId}>素材不可用：{anchor.assetId}</option>}
                {assets.map((asset) => <option key={asset.id} value={asset.id}>{asset.name}</option>)}
              </select>
              <button type="button" disabled={anchors.length <= 2} onClick={() => setAnchors(anchors.filter((_, i) => i !== index))}>删除</button>
            </div>
          ))}
          <button type="button" disabled={anchors.length >= 8} onClick={() => setAnchors([...anchors, { assetId: "", intensity: 1 }])}>添加素材档位</button>
          {error && <p role="alert" className="text-destructive">{error}</p>}
          <button type="button" disabled={busy || !client} className="block underline" onClick={() => void submit()}>保存环境配置</button>
        </div>
      )}
    </div>
  );
}
