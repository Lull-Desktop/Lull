/**
 * 白噪音库窗口：噪音素材库（含预设管理）/ 分类与标签 / 噪音测试三个子页签。
 *
 * 窗口只负责素材资产：导入、编辑、分类标签与 Preset 的保存/导入导出。
 * 预设的「选择并应用」与当前混音的音轨编辑在设置窗的白噪音页签。
 *
 * 媒体订阅由窗口根节点独占：Rust 的 `media_connect` 是“每窗口一份”，
 * 子面板只订阅事件与调用 API，不能各自 connect/disconnect。
 */
"use client";

import type { LullMediaClient, PlaybackSnapshot } from "@lull/media-sdk";
import { Tags, TestTube, Waves } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { LibraryWindowFrame } from "@/components/library/library-window-frame";
import { NoiseApiTestPanel } from "@/components/settings/noise-api-test-panel";
import { NoiseLibraryPanel } from "@/components/settings/noise-library-panel";
import { NoiseTaxonomyPanel } from "@/components/settings/noise-taxonomy-panel";
import { getMediaClient } from "@/hooks/use-media-client";
import { useLocale } from "@/i18n/locale";
import { NOISE_WINDOW_TOPICS } from "@/lib/media-topics";
import { m } from "@/paraglide/messages";

type NoiseTab = "library" | "taxonomy" | "test";

const TABS: { id: NoiseTab; label: () => string; icon: typeof Waves }[] = [
  { id: "library", label: m.noise_tab_library, icon: Waves },
  { id: "taxonomy", label: m.noise_tab_taxonomy, icon: Tags },
  { id: "test", label: m.noise_tab_test, icon: TestTube },
];

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function NoiseLibraryWindow() {
  useLocale();
  const [tab, setTab] = useState<NoiseTab>("library");
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [snapshot, setSnapshot] = useState<PlaybackSnapshot | null>(null);
  const [connectError, setConnectError] = useState("");

  useEffect(() => {
    const media = getMediaClient();
    if (!media) return;
    setClient(media);
    let alive = true;
    void media
      .connect({ topics: [...NOISE_WINDOW_TOPICS], levels: true })
      .then((next) => {
        if (!alive) return;
        setSnapshot(next);
        setConnectError("");
      })
      .catch((reason: unknown) => {
        if (alive) setConnectError(errorText(reason));
      });
    return () => {
      alive = false;
      void media.disconnect();
    };
  }, []);

  const reconnect = useCallback(async (): Promise<PlaybackSnapshot | null> => {
    if (!client) return null;
    try {
      const next = await client.connect({
        topics: [...NOISE_WINDOW_TOPICS],
        levels: true,
      });
      setSnapshot(next);
      setConnectError("");
      return next;
    } catch (reason) {
      setConnectError(errorText(reason));
      return null;
    }
  }, [client]);

  return (
    <LibraryWindowFrame
      title={m.widget_noise_library_name()}
      description={m.widget_noise_library_description()}
      tabs={TABS}
      activeTab={tab}
      onSelectTab={(id) => setTab(id as NoiseTab)}
    >
      {connectError && (
        <p
          role="alert"
          className="rounded-lg border border-destructive/30 bg-destructive/5 px-3 py-2 text-sm text-destructive"
        >
          {m.noise_library_connect_failed({ reason: connectError })}
        </p>
      )}

      <section className="min-h-0 flex-1 overflow-y-auto">
        {tab === "library" && <NoiseLibraryPanel />}
        {tab === "taxonomy" && <NoiseTaxonomyPanel />}
        {tab === "test" && (
          <NoiseApiTestPanel
            client={client}
            snapshot={snapshot}
            onReconnect={reconnect}
          />
        )}
      </section>
    </LibraryWindowFrame>
  );
}
