// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package
"use client";

import type {
  LullMediaClient,
  NoiseSession,
  NoiseTrack,
} from "@lull/media-sdk";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useLocale } from "@/i18n/locale";
import { intensityWeights } from "@/lib/environment-intensity";
import { m } from "@/paraglide/messages";
import { useEnvironmentAssets } from "./noise-environment-assets";
import { EnvironmentCurrentIntensity } from "./noise-environment-current";
import { NoiseEnvironmentForm } from "./noise-environment-form";
import {
  anchorErrors,
  createEnvironmentDraft,
  curveKey,
  draftKey,
  serializeDraft,
} from "./noise-environment-model";

function typeOptions() {
  return {
    rain: m.env_rain(),
    wind: m.env_wind(),
    water: m.env_water(),
    fire: m.env_fire(),
    snow: m.env_snow(),
    lightning: m.env_lightning(),
    "ambient-light": m.env_ambient_light(),
  };
}
function typeLabel(type: string): string {
  return (
    typeOptions()[type as keyof ReturnType<typeof typeOptions>] ??
    m.env_custom({ type })
  );
}

/** Edits only the current track's authored curve. Playback and scene settings stay separate. */
export function NoiseEnvironmentEditor({
  client,
  track,
  onSession,
}: {
  client: LullMediaClient | null;
  track: NoiseTrack;
  onSession?: (session: NoiseSession) => void;
}) {
  useLocale();
  const id = useId();
  const [open, setOpen] = useState(false);
  const [draft, setDraft] = useState(() => createEnvironmentDraft(track));
  const [base, setBase] = useState(() => ({
    key: curveKey(track.environment),
    draft: draftKey(createEnvironmentDraft(track)),
  }));
  const [conflict, setConflict] = useState(false);
  const [busy, setBusy] = useState(false);
  const [formAvailable, setFormAvailable] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const [version, setVersion] = useState(0);
  const observedCurve = useRef(curveKey(track.environment));
  const submitting = useRef(false);
  const pendingCurve = useRef<string | null>(null);
  const alive = useRef(true);
  const dirty = draftKey(draft) !== base.draft;
  const serverKey = curveKey(track.environment);
  const assets = useEnvironmentAssets(
    client,
    [
      ...draft.anchors.map((a) => a.assetId),
      ...(track.environment?.anchors.map((a) => a.assetId) ?? []),
    ],
    version,
    open,
  );
  const rows = anchorErrors(draft.anchors);
  const unavailable = draft.anchors.some(
    (a) => assets[a.assetId]?.status !== "available",
  );
  const invalidCount = draft.anchors.length < 2 || draft.anchors.length > 8;
  const canApply =
    !busy &&
    !!client &&
    !conflict &&
    (dirty || !track.environment) &&
    !invalidCount &&
    rows.every((error) => !error) &&
    !unavailable &&
    formAvailable;
  const currentTrack = useRef(track);
  currentTrack.current = track;

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!client) return;
    return client.events.on((event) => {
      if (event.topic === "noise.library.changed") setVersion((v) => v + 1);
    });
  }, [client]);

  useEffect(() => {
    if (serverKey === observedCurve.current) return;
    observedCurve.current = serverKey;
    if (serverKey === base.key) return;
    if (dirty && pendingCurve.current !== serverKey) {
      setConflict(true);
      return;
    }
    const next = createEnvironmentDraft(currentTrack.current);
    setDraft(next);
    setBase({ key: serverKey, draft: draftKey(next) });
    setConflict(false);
  }, [serverKey, base.key, dirty]);

  const reset = () => {
    const next = createEnvironmentDraft(track);
    setDraft(next);
    setBase({ key: serverKey, draft: draftKey(next) });
    setConflict(false);
    setError("");
    setNotice("");
  };
  const submit = async () => {
    if (!client || !canApply || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    setError("");
    setNotice("");
    let applied = false;
    setRefreshFailed(false);
    try {
      // Fetch the current runtime intensity; never restore the value from when editing began.
      const latest = await client.noise.session.getCurrent();
      if (!alive.current) return;
      const liveTrack = latest.tracks.find((item) => item.id === track.id);
      if (!liveTrack) throw new Error(m.env_gone());
      onSession?.(latest);
      if (curveKey(liveTrack.environment) !== base.key) {
        setConflict(true);
        return;
      }
      const config = serializeDraft(
        draft,
        liveTrack.environment?.intensity ?? 0.5,
      );
      pendingCurve.current = curveKey(config);
      await client.noise.tracks.configureEnvironment(track.id, config);
      applied = true;
      if (!alive.current) return;
      const next = createEnvironmentDraft({
        ...liveTrack,
        environment: config,
      });
      setDraft(next);
      setBase({ key: curveKey(config), draft: draftKey(next) });
      setNotice(m.env_saved());
      const refreshed = await client.noise.session.getCurrent();
      if (alive.current) onSession?.(refreshed);
    } catch (reason) {
      if (alive.current) {
        setRefreshFailed(applied);
        setError(
          (applied ? m.env_refresh_error : m.env_curve_error)({
            reason: reason instanceof Error ? reason.message : String(reason),
          }),
        );
      }
    } finally {
      pendingCurve.current = null;
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const retryRefresh = async () => {
    if (!client || submitting.current) return;
    submitting.current = true;
    setBusy(true);
    try {
      const next = await client.noise.session.getCurrent();
      if (!alive.current) return;
      onSession?.(next);
      setRefreshFailed(false);
      setError("");
    } catch (reason) {
      if (alive.current)
        setError(m.env_refresh_error({ reason: String(reason) }));
    } finally {
      submitting.current = false;
      if (alive.current) setBusy(false);
    }
  };
  const saved = track.environment;
  const weights = saved ? intensityWeights(saved.anchors, saved.intensity) : [];
  return (
    <div className="min-w-0 space-y-2 md:col-span-3">
      <div className="flex flex-wrap items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="link"
          aria-expanded={open}
          aria-controls={`${id}-panel`}
          onClick={() => setOpen((v) => !v)}
        >
          {open ? m.env_close() : saved ? m.env_open() : m.env_create()}
        </Button>
        {saved && (
          <span className="min-w-0 break-words text-xs text-muted-foreground">
            {m.env_summary({
              type: typeLabel(saved.type),
              value: Math.round(saved.intensity * 100),
              count: saved.anchors.length,
            })}
          </span>
        )}
        {(track.error ||
          saved?.anchors.some(
            (a) => assets[a.assetId]?.status === "missing",
          )) && (
          <span className="text-xs text-destructive">
            {m.env_unavailable_summary()}
          </span>
        )}
        {dirty && (
          <output className="text-xs text-amber-700">{m.env_dirty()}</output>
        )}
      </div>
      {open && (
        <section
          id={`${id}-panel`}
          aria-label={m.env_open()}
          className="min-w-0 space-y-4 rounded-lg border border-border bg-background p-3 text-xs"
        >
          <p className="text-muted-foreground">{m.env_zero_hint()}</p>
          {saved && (
            <EnvironmentCurrentIntensity
              client={client}
              track={track}
              disabled={busy}
              onSession={onSession}
            />
          )}
          {saved && (
            <div className="space-y-2">
              <h4 className="font-medium">{m.env_weights()}</h4>
              <ol className="space-y-1">
                {saved.anchors.map((anchor, index) => (
                  <li
                    key={anchor.assetId}
                    className="grid min-w-0 grid-cols-[minmax(0,1fr)_5rem] items-center gap-2"
                  >
                    <span className="break-words">
                      {anchor.intensity * 100}% ·{" "}
                      {assets[anchor.assetId]?.asset?.name ??
                        anchor.expectedName ??
                        anchor.assetId}
                    </span>
                    <span className="text-right">
                      {Math.round(weights[index] * 100)}%
                    </span>
                    <meter
                      aria-label={
                        assets[anchor.assetId]?.asset?.name ?? anchor.assetId
                      }
                      min={0}
                      max={1}
                      value={weights[index]}
                      className="col-span-2 h-2 w-full"
                    />
                  </li>
                ))}
              </ol>
              <p className="text-muted-foreground">{m.env_weight_hint()}</p>
              {dirty && <p>{m.env_verify_saved()}</p>}
              {track.state !== "playing" && <p>{m.env_play_hint()}</p>}
            </div>
          )}
          {conflict && (
            <div role="alert" className="space-y-2 text-amber-700">
              <p>{m.env_conflict()}</p>
              <Button
                type="button"
                size="sm"
                variant="outline"
                disabled={busy}
                onClick={reset}
              >
                {m.env_reload()}
              </Button>
            </div>
          )}
          <NoiseEnvironmentForm
            onAvailabilityChange={setFormAvailable}
            client={client}
            draft={draft}
            disabled={busy}
            onChange={(next) => {
              setDraft(next);
              setNotice("");
            }}
          />
          {error && (
            <p role="alert" className="text-destructive">
              {error}
            </p>
          )}
          {refreshFailed && (
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy}
              onClick={() => void retryRefresh()}
            >
              {m.env_refresh()}
            </Button>
          )}
          {notice && (
            <output className="block text-emerald-700">{notice}</output>
          )}
          <div className="flex flex-wrap gap-2 border-t border-border pt-3">
            <Button
              type="button"
              size="sm"
              disabled={!canApply}
              onClick={() => void submit()}
            >
              {busy ? m.env_saving() : m.env_apply()}
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={busy || (!dirty && !conflict)}
              onClick={reset}
            >
              {m.env_cancel()}
            </Button>
          </div>
        </section>
      )}
    </div>
  );
}
