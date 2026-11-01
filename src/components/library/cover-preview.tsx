/**
 * 曲目封面预览：封面资产由扫描器从内嵌/文件夹写入，Rust 只在
 * `getCoverUrl` 中做 asset-protocol 授权并返回 URL；这里只读，不写文件。
 */
"use client";

import type { LullMediaClient, TrackSummary } from "@lull/media-sdk";
import { ImageIcon } from "lucide-react";
import { useEffect, useState } from "react";
import { cn } from "@/lib/utils";

type CoverPreviewProps = {
  client: LullMediaClient;
  track: TrackSummary;
  className?: string;
};

export function CoverPreview({ client, track, className }: CoverPreviewProps) {
  const [url, setUrl] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let alive = true;
    setUrl(null);
    setFailed(false);
    if (!track.hasCover) return;
    void client.library
      .getCoverUrl(track.id)
      .then((value) => {
        if (alive) setUrl(value);
      })
      .catch(() => {
        if (alive) setFailed(true);
      });
    return () => {
      alive = false;
    };
  }, [client, track.hasCover, track.id]);

  return (
    <div
      className={cn(
        "grid aspect-square w-24 shrink-0 place-items-center overflow-hidden rounded-xl border border-paper-deep/60 bg-paper-warm/60 text-ink-faint",
        className,
      )}
    >
      {url && !failed ? (
        <img
          src={url}
          alt={`${track.title} 封面`}
          className="h-full w-full object-cover"
          onError={() => setFailed(true)}
        />
      ) : (
        <span className="flex flex-col items-center gap-1 text-[10px]">
          <ImageIcon className="h-6 w-6" aria-hidden="true" />
          {track.hasCover ? "封面不可用" : "无封面"}
        </span>
      )}
    </div>
  );
}
