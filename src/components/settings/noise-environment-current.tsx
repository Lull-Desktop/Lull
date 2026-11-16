// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package
"use client";
import type {
  LullMediaClient,
  NoiseSession,
  NoiseTrack,
} from "@lull/media-sdk";
import { useEffect, useId, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { m } from "@/paraglide/messages";
import { percentValue } from "./noise-environment-model";

export function EnvironmentCurrentIntensity({
  client,
  track,
  disabled,
  onSession,
}: {
  client: LullMediaClient | null;
  track: NoiseTrack;
  disabled: boolean;
  onSession?: (session: NoiseSession) => void;
}) {
  const id = useId();
  const intensity = track.environment?.intensity ?? 0;
  const [text, setText] = useState(String(intensity * 100));
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const [refreshFailed, setRefreshFailed] = useState(false);
  const pending = useRef(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);
  useEffect(() => {
    if (!editing && !busy) setText(String(intensity * 100));
  }, [intensity, editing, busy]);
  const apply = async (value: number | null) => {
    if (pending.current || disabled || !client) return;
    if (value === null) {
      setError(m.env_range_error());
      return;
    }
    setError("");
    if (value / 100 === intensity) return;
    pending.current = true;
    setBusy(true);
    let applied = false;
    setRefreshFailed(false);
    try {
      await client.noise.tracks.setIntensity(track.id, value / 100);
      applied = true;
      const next = await client.noise.session.getCurrent();
      if (alive.current) onSession?.(next);
    } catch (reason) {
      if (alive.current) {
        setRefreshFailed(applied);
        setError(
          (applied ? m.env_refresh_error : m.env_live_error)({
            reason: reason instanceof Error ? reason.message : String(reason),
          }),
        );
      }
    } finally {
      pending.current = false;
      if (alive.current) {
        setBusy(false);
        setEditing(false);
      }
    }
  };
  const retryRefresh = async () => {
    if (!client || pending.current || disabled) return;
    pending.current = true;
    setBusy(true);
    try {
      const next = await client.noise.session.getCurrent();
      if (!alive.current) return;
      onSession?.(next);
      setError("");
      setRefreshFailed(false);
    } catch (reason) {
      if (alive.current)
        setError(m.env_refresh_error({ reason: String(reason) }));
    } finally {
      pending.current = false;
      if (alive.current) setBusy(false);
    }
  };
  return (
    <div className="space-y-1">
      <label className="text-xs font-medium" htmlFor={id}>
        {m.env_current()}
      </label>
      <div className="flex items-center gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={m.env_decrease()}
          disabled={!client || disabled || busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            void apply(Math.max(0, (percentValue(text) ?? intensity * 100) - 5))
          }
        >
          −
        </Button>
        <input
          id={id}
          type="number"
          min={0}
          max={100}
          step="any"
          value={text}
          disabled={!client || disabled || busy}
          className="h-8 w-24 rounded-md border border-input bg-background px-2"
          aria-invalid={!!error}
          aria-describedby={`${id}-hint${error ? ` ${id}-error` : ""}`}
          onFocus={() => setEditing(true)}
          onChange={(e) => setText(e.target.value)}
          onBlur={() => {
            setEditing(false);
            void apply(percentValue(text));
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              e.currentTarget.blur();
            }
          }}
        />
        <Button
          type="button"
          size="sm"
          variant="outline"
          aria-label={m.env_increase()}
          disabled={!client || disabled || busy}
          onMouseDown={(e) => e.preventDefault()}
          onClick={() =>
            void apply(
              Math.min(100, (percentValue(text) ?? intensity * 100) + 5),
            )
          }
        >
          +
        </Button>
      </div>
      <p id={`${id}-hint`} className="text-xs text-muted-foreground">
        {m.env_current_hint()}
      </p>
      {refreshFailed && (
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={busy || disabled}
          onClick={() => void retryRefresh()}
        >
          {m.env_refresh()}
        </Button>
      )}
      {error && (
        <p id={`${id}-error`} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
    </div>
  );
}
