/**
 * 设置页的音乐库面板（P1）：来源、扫描、搜索与曲目预览。
 *
 * 这里只消费 @lull/media-sdk；不直接 invoke、不读数据库、不解析文件。
 */
"use client";

import {
  type AlbumSummary,
  type ArtistSummary,
  createMediaClient,
  type LullMediaClient,
  type SourceView,
  type TrackQuery,
  type TrackSummary,
} from "@lull/media-sdk";
import { FolderPlus, Library, Music, RefreshCw, Search } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { m } from "@/paraglide/messages";

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}

function formatDuration(durationMs?: number): string {
  if (!durationMs || !Number.isFinite(durationMs) || durationMs <= 0) {
    return "--:--";
  }
  const total = Math.round(durationMs / 1000);
  const minutes = Math.floor(total / 60);
  const seconds = total % 60;
  return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
}

type LibraryFilters = {
  artistId: string;
  albumId: string;
  genre: string;
  format: string;
  year: string;
};

const EMPTY_FILTERS: LibraryFilters = {
  artistId: "",
  albumId: "",
  genre: "",
  format: "",
  year: "",
};

const FORMATS = ["mp3", "flac", "m4a", "aac", "wav", "ogg", "opus", "aiff"];

function toTrackQuery(keyword: string, filters: LibraryFilters): TrackQuery {
  const year = Number.parseInt(filters.year, 10);
  return {
    keyword: keyword.trim() || undefined,
    artistId: filters.artistId || undefined,
    albumId: filters.albumId || undefined,
    genre: filters.genre.trim() || undefined,
    format: filters.format || undefined,
    year: Number.isFinite(year) ? year : undefined,
    pageSize: 50,
  };
}

function sourceStatusLabel(status: SourceView["status"]): string {
  switch (status) {
    case "scanning":
      return m.settings_library_status_scanning();
    case "error":
      return m.settings_library_status_error();
    case "missing":
      return m.settings_library_status_missing();
    default:
      return "";
  }
}

export function MusicLibraryPanel({
  client: providedClient,
}: {
  /** 测试/嵌入时注入；不传则自动创建 Tauri 客户端。 */
  client?: LullMediaClient;
} = {}) {
  const [client, setClient] = useState<LullMediaClient | null>(null);
  const [sources, setSources] = useState<SourceView[]>([]);
  const [tracks, setTracks] = useState<TrackSummary[]>([]);
  const [total, setTotal] = useState(0);
  const [artists, setArtists] = useState<ArtistSummary[]>([]);
  const [albums, setAlbums] = useState<AlbumSummary[]>([]);
  const [genres, setGenres] = useState<string[]>([]);
  const [keyword, setKeyword] = useState("");
  const [appliedKeyword, setAppliedKeyword] = useState("");
  const [filters, setFilters] = useState<LibraryFilters>(EMPTY_FILTERS);
  const [appliedFilters, setAppliedFilters] =
    useState<LibraryFilters>(EMPTY_FILTERS);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [scanProgress, setScanProgress] = useState<
    Record<string, { processed: number; total: number }>
  >({});

  const refresh = useCallback(
    async (
      target: LullMediaClient,
      search = "",
      nextFilters: LibraryFilters = EMPTY_FILTERS,
    ) => {
      const [nextSources, page, nextArtists, nextAlbums, nextGenres] =
        await Promise.all([
          target.library.listSources(),
          target.library.listTracks(toTrackQuery(search, nextFilters)),
          target.library.listArtists(),
          target.library.listAlbums(),
          target.library.listGenres(),
        ]);
      setSources(nextSources);
      setTracks(page.items);
      setTotal(page.total);
      setArtists(nextArtists);
      setAlbums(nextAlbums);
      setGenres(nextGenres);
    },
    [],
  );

  useEffect(() => {
    if (providedClient) {
      setClient(providedClient);
      return;
    }
    let alive = true;
    try {
      const next = createMediaClient();
      setClient(next);
      return () => {
        alive = false;
        next.dispose();
      };
    } catch (reason) {
      if (alive) setError(errorText(reason));
    }
    return () => {
      alive = false;
    };
  }, [providedClient]);

  useEffect(() => {
    if (!client) return;
    const stop = client.events.on((event) => {
      if (event.topic === "library.scan.started") {
        void refresh(client, appliedKeyword, appliedFilters).catch(
          (reason: unknown) => {
            setError(errorText(reason));
          },
        );
      } else if (event.topic === "library.scan.progress") {
        const payload = event.payload as {
          sourceId?: string;
          processed?: number;
          total?: number;
        };
        if (!payload.sourceId) return;
        setScanProgress((previous) => ({
          ...previous,
          [payload.sourceId as string]: {
            processed: payload.processed ?? 0,
            total: payload.total ?? 0,
          },
        }));
      } else if (event.topic === "library.scan.finished") {
        setScanProgress({});
      } else if (event.topic === "library.changed") {
        void refresh(client, appliedKeyword, appliedFilters).catch(
          (reason: unknown) => {
            setError(errorText(reason));
          },
        );
      }
    });
    return stop;
  }, [appliedFilters, appliedKeyword, client, refresh]);

  useEffect(() => {
    if (!client) return;
    void refresh(client, appliedKeyword, appliedFilters).catch(
      (reason: unknown) => {
        setError(errorText(reason));
      },
    );
  }, [appliedFilters, appliedKeyword, client, refresh]);

  const hasScanning = useMemo(
    () => sources.some((source) => source.status === "scanning"),
    [sources],
  );

  useEffect(() => {
    if (!client || !hasScanning) return;
    const timer = window.setInterval(() => {
      void refresh(client, appliedKeyword, appliedFilters).catch(
        (reason: unknown) => {
          setError(errorText(reason));
        },
      );
    }, 1500);
    return () => window.clearInterval(timer);
  }, [appliedFilters, appliedKeyword, client, hasScanning, refresh]);

  const run = useCallback(
    async (label: string, action: () => Promise<void>) => {
      setBusy(label);
      setError(null);
      try {
        await action();
      } catch (reason) {
        setError(m.settings_library_error({ reason: errorText(reason) }));
      } finally {
        setBusy(null);
      }
    },
    [],
  );

  const addSource = useCallback(() => {
    if (!client) return;
    void run("add", async () => {
      const added = await client.library.addSource();
      if (added) {
        await client.library.startScan(added.id);
        await refresh(client, appliedKeyword, appliedFilters);
      }
    });
  }, [appliedFilters, appliedKeyword, client, refresh, run]);

  const scan = useCallback(
    (source: SourceView) => {
      if (!client) return;
      void run(`scan:${source.id}`, async () => {
        await client.library.startScan(source.id);
        await refresh(client, appliedKeyword, appliedFilters);
      });
    },
    [appliedFilters, appliedKeyword, client, refresh, run],
  );

  const cancelScan = useCallback(
    (source: SourceView) => {
      if (!client) return;
      void run(`cancel:${source.id}`, async () => {
        await client.library.cancelScan(source.id);
      });
    },
    [client, run],
  );

  const refreshSources = useCallback(() => {
    if (!client) return;
    void run("refresh", async () => {
      await refresh(client, appliedKeyword, appliedFilters);
    });
  }, [appliedFilters, appliedKeyword, client, refresh, run]);

  const applyFilters = useCallback(
    (next: LibraryFilters) => {
      if (!client) return;
      setAppliedFilters(next);
      void run("filter", async () => {
        await refresh(client, appliedKeyword, next);
      });
    },
    [appliedKeyword, client, refresh, run],
  );

  const updateFilter = useCallback(
    (key: keyof LibraryFilters, value: string) => {
      const next = { ...filters, [key]: value };
      setFilters(next);
      applyFilters(next);
    },
    [applyFilters, filters],
  );

  const resetFilters = useCallback(() => {
    setFilters(EMPTY_FILTERS);
    applyFilters(EMPTY_FILTERS);
  }, [applyFilters]);

  const submitSearch = useCallback(() => {
    if (!client) return;
    const next = keyword.trim();
    setAppliedKeyword(next);
    void run("search", async () => {
      await refresh(client, next, appliedFilters);
    });
  }, [appliedFilters, client, keyword, refresh, run]);

  return (
    <Card className="w-full" data-testid="music-library-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Library className="h-5 w-5 text-bamboo" />
          {m.settings_library_title()}
        </CardTitle>
        <CardDescription>{m.settings_library_description()}</CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <section className="space-y-2">
          <div className="flex items-center justify-between gap-3">
            <h3 className="text-sm font-medium text-ink-soft">
              {m.settings_library_sources()}
            </h3>
            <div className="flex gap-2">
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={!client || busy !== null}
                onClick={() => void refreshSources()}
              >
                <RefreshCw aria-hidden="true" />
                {m.settings_library_refresh()}
              </Button>
              <Button
                type="button"
                variant="bamboo"
                size="sm"
                disabled={!client || busy !== null}
                onClick={addSource}
              >
                <FolderPlus aria-hidden="true" />
                {m.settings_library_add_source()}
              </Button>
            </div>
          </div>

          {sources.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
              {m.settings_library_empty()}
            </p>
          ) : (
            <ul className="space-y-2">
              {sources.map((source) => (
                <li
                  key={source.id}
                  className="flex min-w-0 items-center justify-between gap-3 rounded-xl border border-border/60 px-3 py-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm text-ink">{source.name}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {source.rootPath ?? source.kind}
                    </p>
                    {sourceStatusLabel(source.status) && (
                      <p className="mt-0.5 text-xs text-muted-foreground">
                        {sourceStatusLabel(source.status)}
                        {source.lastScanError
                          ? ` · ${source.lastScanError}`
                          : ""}
                      </p>
                    )}
                  </div>
                  {source.kind === "local" && (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      {source.status === "scanning" &&
                        scanProgress[source.id] && (
                          <span className="text-xs tabular-nums text-muted-foreground">
                            {scanProgress[source.id]?.processed ?? 0}/
                            {scanProgress[source.id]?.total ?? 0}
                          </span>
                        )}
                      <div className="flex gap-1">
                        <Button
                          type="button"
                          variant="outline"
                          size="sm"
                          disabled={
                            !client ||
                            busy !== null ||
                            source.status === "scanning"
                          }
                          onClick={() => scan(source)}
                        >
                          {source.status === "scanning"
                            ? m.settings_library_scanning()
                            : m.settings_library_scan()}
                        </Button>
                        {source.status === "scanning" && (
                          <Button
                            type="button"
                            variant="ghost"
                            size="sm"
                            disabled={!client || busy !== null}
                            onClick={() => cancelScan(source)}
                          >
                            {m.settings_library_cancel_scan()}
                          </Button>
                        )}
                      </div>
                    </div>
                  )}
                </li>
              ))}
            </ul>
          )}
        </section>

        <form
          className="flex gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            submitSearch();
          }}
        >
          <input
            type="search"
            value={keyword}
            onChange={(event) => setKeyword(event.target.value)}
            placeholder={m.settings_library_search_placeholder()}
            aria-label={m.settings_library_search_placeholder()}
            className="h-9 min-w-0 flex-1 rounded-full border border-border/70 bg-paper px-3 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
          />
          <Button
            type="submit"
            variant="bamboo"
            size="sm"
            disabled={!client || busy !== null}
          >
            <Search aria-hidden="true" />
            {m.settings_library_search()}
          </Button>
        </form>

        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
          <select
            aria-label={m.settings_library_filter_artist()}
            value={filters.artistId}
            onChange={(event) => updateFilter("artistId", event.target.value)}
            className="h-9 min-w-0 rounded-lg border border-border/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
          >
            <option value="">{m.settings_library_filter_artist()}</option>
            {artists.map((artist) => (
              <option key={artist.id} value={artist.id}>
                {artist.name}
              </option>
            ))}
          </select>
          <select
            aria-label={m.settings_library_filter_album()}
            value={filters.albumId}
            onChange={(event) => updateFilter("albumId", event.target.value)}
            className="h-9 min-w-0 rounded-lg border border-border/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
          >
            <option value="">{m.settings_library_filter_album()}</option>
            {albums.map((album) => (
              <option key={album.id} value={album.id}>
                {album.title}
              </option>
            ))}
          </select>
          <select
            aria-label={m.settings_library_filter_genre()}
            value={filters.genre}
            onChange={(event) => updateFilter("genre", event.target.value)}
            className="h-9 min-w-0 rounded-lg border border-border/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
          >
            <option value="">{m.settings_library_filter_genre()}</option>
            {genres.map((genre) => (
              <option key={genre} value={genre}>
                {genre}
              </option>
            ))}
          </select>
          <select
            aria-label={m.settings_library_filter_format()}
            value={filters.format}
            onChange={(event) => updateFilter("format", event.target.value)}
            className="h-9 min-w-0 rounded-lg border border-border/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
          >
            <option value="">{m.settings_library_filter_format()}</option>
            {FORMATS.map((format) => (
              <option key={format} value={format}>
                {format.toUpperCase()}
              </option>
            ))}
          </select>
          <input
            type="number"
            inputMode="numeric"
            aria-label={m.settings_library_filter_year()}
            placeholder={m.settings_library_filter_year()}
            value={filters.year}
            onChange={(event) => updateFilter("year", event.target.value)}
            className="h-9 min-w-0 rounded-lg border border-border/70 bg-paper px-2 text-sm text-ink outline-none focus-visible:ring-2 focus-visible:ring-bamboo/50"
          />
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={!client || busy !== null}
            onClick={resetFilters}
          >
            {m.settings_library_filter_reset()}
          </Button>
        </div>

        <div className="grid grid-cols-3 gap-2 text-center">
          <div className="rounded-xl bg-paper-warm/60 px-2 py-2">
            <p className="text-lg font-semibold text-ink">{total}</p>
            <p className="text-xs text-muted-foreground">
              {m.settings_library_tracks()}
            </p>
          </div>
          <div className="rounded-xl bg-paper-warm/60 px-2 py-2">
            <p className="text-lg font-semibold text-ink">{artists.length}</p>
            <p className="text-xs text-muted-foreground">
              {m.settings_library_artists()}
            </p>
          </div>
          <div className="rounded-xl bg-paper-warm/60 px-2 py-2">
            <p className="text-lg font-semibold text-ink">{albums.length}</p>
            <p className="text-xs text-muted-foreground">
              {m.settings_library_albums()}
            </p>
          </div>
        </div>

        {error && (
          <p className="text-xs text-destructive" role="alert">
            {error}
          </p>
        )}

        <section className="space-y-2">
          <h3 className="text-sm font-medium text-ink-soft">
            {m.settings_library_tracks()}
          </h3>
          {tracks.length === 0 ? (
            <p className="rounded-xl border border-dashed border-border/70 px-3 py-4 text-sm text-muted-foreground">
              {m.settings_library_empty()}
            </p>
          ) : (
            <ul className="divide-y divide-border/50 rounded-xl border border-border/60">
              {tracks.map((track) => (
                <li
                  key={track.id}
                  className="flex min-w-0 items-center gap-3 px-3 py-2"
                >
                  <Music
                    aria-hidden="true"
                    className="h-4 w-4 shrink-0 text-bamboo"
                  />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-ink">{track.title}</p>
                    <p className="truncate text-xs text-muted-foreground">
                      {track.artists.join(" / ") || "—"}
                      {track.album ? ` · ${track.album}` : ""}
                      {track.genre ? ` · ${track.genre}` : ""}
                      {track.available ? "" : " · unavailable"}
                    </p>
                  </div>
                  <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
                    {formatDuration(track.durationMs)}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </CardContent>
    </Card>
  );
}
