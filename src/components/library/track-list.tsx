/**
 * 曲目列表：设置页音乐浏览与音乐管理窗口共用。
 *
 * `full` 保留库窗口原有的收藏 / 播放 / 加入队列 / 编辑元数据 / 移除 / 加入歌单，
 * 给 1080px 宽的库窗口用；`compact` 去掉编辑元数据与加入歌单（保留可选的移除，
 * 队列要用它「移出队列」），给 736px 宽的设置窗内容区用，行内按钮不会挤成两三行。
 *
 * 列表本身不带滚动：调用方负责限高 + `overflow-y-auto`（库窗口的页签滚动区、
 * 设置页音乐浏览的内容区）。
 */
"use client";

import type { TrackSummary } from "@lull/media-sdk";
import { Heart, Pencil, Play, Plus, Square, Trash2, X } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import { m } from "@/paraglide/messages";

export function formatDuration(durationMs?: number): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "--:--";
  }
  const total = Math.round(durationMs / 1000);
  return `${String(Math.floor(total / 60)).padStart(2, "0")}:${String(
    total % 60,
  ).padStart(2, "0")}`;
}

export type TrackListProps = {
  tracks: TrackSummary[];
  /** 「加入歌单」下拉的选项；compact 变体不使用。 */
  playlists?: { id: string; name: string }[];
  busy: string | null;
  empty: string;
  showFileName?: boolean;
  /** 正在播放的曲目；与当前行一致时按钮显示「停止」。 */
  playingTrackId: string | null;
  /** 行首额外注记（例如「最近播放」的播放时间），跟在专辑/年份之后。 */
  subtitleSuffix?: (track: TrackSummary) => string | null;
  /** 强调行：队列用来标记当前播放位置。 */
  highlightedTrackId?: string | null;
  /** 额外的行内「移除」操作；文案由 `removeLabel` 提供。 */
  onRemove?: (track: TrackSummary) => void;
  removeLabel?: string;
  /** 移除按钮图标；默认 X，单曲删除用垃圾桶。 */
  removeIcon?: "x" | "trash";
  onPlay: (track: TrackSummary) => void;
  onQueue: (track: TrackSummary) => void;
  onFavorite: (track: TrackSummary) => void;
  onAddToPlaylist?: (playlistId: string, track: TrackSummary) => void;
  onEdit?: (track: TrackSummary) => void;
  /** 默认 `full`；`compact` 用于窄内容区，去掉编辑 / 移除 / 加入歌单。 */
  variant?: "full" | "compact";
};

export function TrackList(props: TrackListProps) {
  const compact = props.variant === "compact";
  if (props.tracks.length === 0) {
    return (
      <p
        className={cn(
          "text-center text-sm text-ink-faint",
          compact ? "py-10" : "py-16",
        )}
      >
        {props.empty}
      </p>
    );
  }
  return (
    <div className="divide-y divide-paper-deep/50 rounded-xl border border-paper-deep/60 bg-card">
      {props.tracks.map((track) => {
        const subtitleSuffix = props.subtitleSuffix?.(track) ?? null;
        return (
          <div
            key={track.id}
            className={cn(
              "flex flex-wrap items-center",
              compact ? "gap-2 px-3 py-2" : "gap-3 px-3 py-2.5",
              props.highlightedTrackId === track.id && "bg-bamboo-mist/40",
            )}
          >
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium">{track.title}</p>
              <p className="truncate text-xs text-ink-faint">
                {track.artists.join(", ") || "—"}
                {track.album ? ` · ${track.album}` : ""}
                {track.year ? ` · ${track.year}` : ""}
                {props.showFileName && track.fileName
                  ? ` · ${track.fileName}`
                  : ""}
                {subtitleSuffix ? ` · ${subtitleSuffix}` : ""}
              </p>
            </div>
            <span className="w-14 text-right text-xs text-ink-faint">
              {formatDuration(track.durationMs)}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => props.onFavorite(track)}
              disabled={props.busy !== null}
              title={
                track.favorite
                  ? m.library_favorite_remove()
                  : m.library_favorite_add()
              }
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
              disabled={!track.available}
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
            {!compact && props.onEdit ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => props.onEdit?.(track)}
                disabled={props.busy !== null}
                title="编辑元数据与标签"
              >
                <Pencil className="h-4 w-4" aria-hidden="true" />
              </Button>
            ) : null}
            {props.onRemove ? (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => props.onRemove?.(track)}
                disabled={props.busy !== null}
                title={props.removeLabel}
              >
                {props.removeIcon === "trash" ? (
                  <Trash2 className="h-4 w-4" aria-hidden="true" />
                ) : (
                  <X className="h-4 w-4" aria-hidden="true" />
                )}
                {props.removeLabel}
              </Button>
            ) : null}
            {!compact &&
            props.onAddToPlaylist &&
            (props.playlists?.length ?? 0) > 0 ? (
              <select
                className="max-w-[10rem] rounded-md border border-paper-deep/70 bg-paper-warm px-2 py-1 text-xs"
                defaultValue=""
                onChange={(event) => {
                  const playlistId = event.target.value;
                  if (playlistId) props.onAddToPlaylist?.(playlistId, track);
                  event.target.value = "";
                }}
                aria-label={m.library_playlist_add_to()}
              >
                <option value="">{m.library_playlist_add_to()}</option>
                {props.playlists?.map((playlist) => (
                  <option key={playlist.id} value={playlist.id}>
                    {playlist.name}
                  </option>
                ))}
              </select>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
