/**
 * 歌单详情列表：序号 / 上移下移 / 收藏 / 播放 / 加入队列 / 移出歌单。
 *
 * 只在设置页的音乐浏览里使用；滚动与限高由调用方的内容区负责。
 */
"use client";

import type { PlaylistDetail, TrackSummary } from "@lull/media-sdk";
import {
  ChevronDown,
  ChevronUp,
  Heart,
  Play,
  Plus,
  Square,
  Trash2,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

type PlaylistTracksProps = {
  detail: PlaylistDetail;
  busy: string | null;
  playingTrackId: string | null;
  onPlay: (track: TrackSummary) => void;
  onQueue: (track: TrackSummary) => void;
  onFavorite: (track: TrackSummary) => void;
  onRemove: (trackId: string) => void;
  onMove: (trackId: string, current: number, direction: -1 | 1) => void;
};

export function PlaylistTracks(props: PlaylistTracksProps) {
  const entries = props.detail.entries;
  if (entries.length === 0) {
    return (
      <p className="py-10 text-center text-sm text-ink-faint">
        {m.library_playlist_empty()}
      </p>
    );
  }
  return (
    <div className="space-y-1">
      {entries.map((entry, index) => {
        const track = entry.track;
        return (
          <div
            key={entry.trackId}
            className="flex flex-wrap items-center gap-2 rounded-md px-2 py-2 hover:bg-paper-warm"
          >
            <span className="w-6 text-right text-xs text-ink-faint">
              {index + 1}
            </span>
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">
                {track?.title ?? entry.trackId}
              </p>
              <p className="truncate text-xs text-ink-faint">
                {track?.artists.join(", ")}
              </p>
            </div>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onMove(entry.trackId, index, -1)}
              disabled={index === 0 || props.busy !== null}
              aria-label={m.library_playlist_move_up()}
            >
              <ChevronUp className="h-4 w-4" aria-hidden="true" />
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onMove(entry.trackId, index, 1)}
              disabled={index === entries.length - 1 || props.busy !== null}
              aria-label={m.library_playlist_move_down()}
            >
              <ChevronDown className="h-4 w-4" aria-hidden="true" />
            </Button>
            {track && (
              <>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onFavorite(track)}
                  disabled={props.busy !== null}
                >
                  <Heart
                    className={cn(
                      "h-4 w-4",
                      track.favorite && "fill-current text-destructive",
                    )}
                    aria-hidden="true"
                  />
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onPlay(track)}
                >
                  {props.playingTrackId === track.id ? (
                    <Square
                      className="mr-1 h-4 w-4 fill-current"
                      aria-hidden="true"
                    />
                  ) : (
                    <Play className="mr-1 h-4 w-4" aria-hidden="true" />
                  )}
                  {props.playingTrackId === track.id
                    ? m.library_stop()
                    : m.library_play()}
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  onClick={() => props.onQueue(track)}
                  disabled={props.busy !== null}
                >
                  <Plus className="mr-1 h-4 w-4" aria-hidden="true" />
                  {m.library_queue_add()}
                </Button>
              </>
            )}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onRemove(entry.trackId)}
              disabled={props.busy !== null}
            >
              <Trash2 className="mr-1 h-4 w-4" aria-hidden="true" />
              {m.library_playlist_remove_track()}
            </Button>
          </div>
        );
      })}
    </div>
  );
}
