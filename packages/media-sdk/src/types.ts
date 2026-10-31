/**
 * Media API 的公开 DTO。Rust 侧 serde 是事实源；这里手工镜像并由 client 测试
 * 锁定字段形状，P5 再评估是否引入 ts-rs 生成。
 */

export type MediaProtocol = 1;

export type SourceKind = "local" | "builtin";
export type SourceStatus = "active" | "scanning" | "missing" | "error";

export interface SourceView {
  id: string;
  kind: SourceKind;
  name: string;
  status: SourceStatus;
  rootPath?: string;
  lastScanAt?: number;
  lastScanError?: string;
}

export interface TrackQuery {
  keyword?: string;
  sourceIds?: string[];
  page?: number;
  pageSize?: number;
  sortBy?: "title" | "addedAt" | "year" | "duration" | "artist";
  sortOrder?: "asc" | "desc";
  includeUnavailable?: boolean;
}

export interface TrackSummary {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  albumId?: string;
  durationMs?: number;
  year?: number;
  trackNumber?: number;
  discNumber?: number;
  source: "local" | "builtin";
  available: boolean;
  hasCover: boolean;
}

export interface Page<T> {
  items: T[];
  total: number;
  page: number;
  pageSize: number;
  hasMore: boolean;
}

export interface TrackFileView {
  format: string;
  sizeBytes: number;
  bitrate?: number;
  sampleRate?: number;
  available: boolean;
}

export interface TrackDetail extends TrackSummary {
  metadata: Record<string, unknown> | null;
  files: TrackFileView[];
}

export interface ArtistSummary {
  id: string;
  name: string;
  kind: string;
  trackCount: number;
  needsReview: boolean;
}

export interface AlbumSummary {
  id: string;
  title: string;
  year?: number;
  kind: string;
  albumArtist?: string;
  trackCount: number;
  hasCover: boolean;
}

export type ScanJobStatus = "running" | "completed" | "failed" | "cancelled";

export interface ScanJobView {
  jobId: string;
  sourceId: string;
  status: ScanJobStatus;
}

export interface MediaErrorBody {
  code: string;
  message: string;
  details?: unknown;
}
