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

/** 物理目录（内部复用 music_sources 的 local 行）。 */
export type MusicFolderStatus =
  | "available"
  | "scanning"
  | "missing"
  | "error";

export interface MusicFolderView {
  id: string;
  name: string;
  rootPath?: string;
  recursive: boolean;
  status: MusicFolderStatus;
  trackCount: number;
  lastScannedAt?: number;
  lastScanError?: string;
  createdAt: number;
  updatedAt: number;
}

export interface FolderTrack extends TrackSummary {
  relativePath: string;
}

export interface TrackQuery {
  keyword?: string;
  sourceIds?: string[];
  folderId?: string;
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
  tagId?: string;
}

export interface TagView {
  id: string;
  name: string;
  trackCount: number;
}

export interface SmartPlaylistView {
  id: string;
  name: string;
  description?: string;
  rules: TrackQuery;
  createdAt: number;
  updatedAt: number;
}

export interface TrackMetadataPatch {
  trackId: string;
  title?: string;
  artists?: string[];
  album?: string | null;
  genre?: string | null;
  year?: number | null;
}

export interface BackupCounts {
  playlists: number;
  favorites: number;
  history: number;
  tags: number;
  smartPlaylists: number;
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
  tags?: TagView[];
  source: "local";
  available: boolean;
  hasCover: boolean;
  favorite?: boolean;
  folderId?: string;
  folderName?: string;
  addedAt?: number;
  fileName?: string;
  format?: string;
  fileSize?: number;
  bitrate?: number;
  sampleRate?: number;
  fileModifiedAt?: number;
  albumArtId?: string;
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
  fileName?: string;
  fileModifiedAt?: number;
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
  folderId?: string;
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
  sourceType?: "builtin" | "user" | string;
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
  sourceType: "builtin" | "user" | string;
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

export interface NoisePresetSummary {
  id: string;
  originId?: string;
  name: string;
  description?: string;
  sourceType: "builtin" | "user" | "community" | string;
  author?: string;
  schemaVersion: number;
  masterVolume: number;
  coverRef?: string;
  favorite: boolean;
  trackCount: number;
  createdAt: number;
  updatedAt: number;
}

export interface NoisePresetTrack {
  id: string;
  assetId?: string;
  assetHash?: string;
  assetSourceType?: string;
  assetSourceId?: string;
  expectedName: string;
  volume: number;
  enabled: boolean;
  loop: boolean;
  fadeInMs?: number;
  fadeOutMs?: number;
  sortOrder: number;
  status: "resolved" | "missing";
  assetName?: string;
}

export interface NoisePresetDetail {
  preset: NoisePresetSummary;
  tracks: NoisePresetTrack[];
}

export interface NoisePresetQuery {
  keyword?: string;
  sourceType?: NoisePresetSummary["sourceType"];
  favoriteOnly?: boolean;
  page?: number;
  pageSize?: number;
}

export interface NoisePresetMissing {
  presetTrackId: string;
  expectedName: string;
  candidates: NoiseAsset[];
}

export interface NoisePresetLoadResult {
  preset: NoisePresetSummary;
  session: NoiseSession;
  resolved: string[];
  missing: NoisePresetMissing[];
}

export interface NoisePresetExportResult {
  fileName?: string;
}

export interface MediaOutput {
  volume: number;
  muted: boolean;
}

export interface PlaybackSnapshot {
  protocol: 1;
  revision: number;
  /** Widget 快照在未授权 `media.player.read` 时省略；官方窗口始终有值。 */
  player?: PlayerState;
  /** Widget 快照在未授权 `media.queue.read` 时省略；官方窗口始终有值。 */
  queue?: QueueState;
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
