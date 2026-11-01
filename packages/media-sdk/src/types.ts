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
  artistId?: string;
  albumId?: string;
  genre?: string;
  format?: string;
  year?: number;
  yearFrom?: number;
  yearTo?: number;
  page?: number;
  pageSize?: number;
  sortBy?: "title" | "addedAt" | "year" | "duration" | "artist" | "genre";
  sortOrder?: "asc" | "desc";
  includeUnavailable?: boolean;
  favoriteOnly?: boolean;
}

export interface TrackSummary {
  id: string;
  title: string;
  artists: string[];
  album?: string;
  albumId?: string;
  durationMs?: number;
  year?: number;
  genre?: string;
  trackNumber?: number;
  discNumber?: number;
  source: "local" | "online";
  available: boolean;
  hasCover: boolean;
  favorite?: boolean;
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

export interface TrackLyrics {
  format: string;
  source: string;
  content: string;
  offsetMs: number;
  language?: string;
}

export interface TrackDetail extends TrackSummary {
  metadata: Record<string, unknown> | null;
  files: TrackFileView[];
  lyrics?: TrackLyrics;
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

export type PlaybackStatus =
  | "idle"
  | "loading"
  | "playing"
  | "paused"
  | "ended"
  | "error";

export type PlayMode = "sequence" | "shuffle" | "repeat-one";

export interface PlayerState {
  track?: TrackSummary;
  status: PlaybackStatus;
  positionMs: number;
  durationMs?: number;
  volume: number;
  muted: boolean;
  mode: PlayMode;
  revision: number;
  error?: MediaErrorBody;
}

export interface QueueState {
  trackIds: string[];
  currentIndex?: number;
  revision: number;
}

export interface NoiseLayer {
  soundId: string;
  enabled: boolean;
  volume: number;
}

export interface NoiseState {
  sessionId: string;
  active: boolean;
  master: number;
  muted: boolean;
  layers: NoiseLayer[];
  sleep: { timerMinutes: number; endsAt?: number };
  revision: number;
}

export interface NoiseSound {
  id: string;
  name: string;
}

export interface NoiseSleep {
  timerMinutes: number;
  endsAt?: number;
}

export type NoiseSessionState = "idle" | "playing" | "paused";

export type NoiseTrackState = "playing" | "paused" | "stopped";

export interface NoiseTrackError {
  code: string;
  message: string;
}

export interface NoiseTrack {
  id: string;
  assetId: string;
  name: string;
  state: NoiseTrackState;
  volume: number;
  enabled: boolean;
  loop: boolean;
  positionMs: number;
  fadeInMs?: number;
  fadeOutMs?: number;
  order: number;
  error?: NoiseTrackError;
}

export interface NoiseAssetCategory {
  id: string;
  name: string;
}

export interface NoiseTag {
  id: string;
  name: string;
  assetCount?: number;
}

export interface NoiseAssetCapabilities {
  loop: boolean;
  seek: boolean;
  fade: boolean;
}

export interface NoiseAsset {
  id: string;
  name: string;
  description?: string;
  mediaKind: "procedural" | "file";
  format: string;
  durationMs?: number;
  sampleRate?: number;
  channels?: number;
  sizeBytes: number;
  category?: NoiseAssetCategory;
  tags: NoiseTag[];
  favorite: boolean;
  status: "available" | "missing" | "invalid";
  source: string;
  capabilities: NoiseAssetCapabilities;
  createdAt: number;
  updatedAt: number;
}

export interface NoiseCategory {
  id: string;
  name: string;
  parentId?: string;
  icon?: string;
  sortOrder: number;
  assetCount: number;
}

export interface NoiseAssetQuery {
  keyword?: string;
  categoryId?: string;
  tagId?: string;
  favoriteOnly?: boolean;
  status?: NoiseAsset["status"];
  mediaKind?: NoiseAsset["mediaKind"];
  page?: number;
  pageSize?: number;
  sortBy?: "name" | "duration" | "created_at" | "updated_at";
  sortOrder?: "asc" | "desc";
}

export interface NoiseImportFailure {
  fileName: string;
  code: string;
  reason: string;
}

export interface NoiseImportResult {
  imported: NoiseAsset[];
  duplicates: NoiseAsset[];
  failed: NoiseImportFailure[];
}

export interface NoiseRevalidateResult {
  checked: number;
  missing: number;
  restored: number;
}

export interface NoiseSession {
  id: string;
  name?: string;
  state: NoiseSessionState;
  masterVolume: number;
  muted: boolean;
  tracks: NoiseTrack[];
  sleep: NoiseSleep;
  revision: number;
  createdAt: number;
}

export interface MediaOutput {
  volume: number;
  muted: boolean;
}

export interface PlaybackSnapshot {
  protocol: 1;
  revision: number;
  player: PlayerState;
  queue: QueueState;
  output: MediaOutput;
  noise: NoiseState;
  noiseSession: NoiseSession;
}

export interface ConnectOptions {
  topics?: string[];
  progressMs?: number;
  levels?: boolean;
}

export interface PlaylistSummary {
  id: string;
  name: string;
  description?: string;
  trackCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistEntry {
  trackId: string;
  track?: TrackSummary;
}

export interface PlaylistDetail extends PlaylistSummary {
  entries: PlaylistEntry[];
}

export interface FavoriteView {
  trackId: string;
  favorite: boolean;
}

export interface HistoryEntry {
  id: string;
  trackId: string;
  track?: TrackSummary;
  playedAt: number;
  completed: boolean;
}

export interface M3uImportResult {
  playlist: PlaylistDetail;
  imported: number;
  missing: string[];
}

export interface M3uExportResult {
  exported: number;
  skipped: number;
}
