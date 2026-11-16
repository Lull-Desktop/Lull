// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package
"use client";
import type {
  LullMediaClient,
  NoisePresetDetail,
  NoisePresetUpdatePatch,
} from "@lull/media-sdk";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useConfirmDialog } from "@/components/ui/confirm-dialog";
import { Label } from "@/components/ui/label";
import { useLocale } from "@/i18n/locale";
import { m } from "@/paraglide/messages";
import {
  environmentTypeLabel,
  NoiseEnvironmentForm,
} from "./noise-environment-form";
import {
  anchorErrors,
  createEnvironmentDraft,
  draftKey,
  type EnvironmentDraft,
  percentValue,
  serializeDraft,
} from "./noise-environment-model";

export type PresetLeaveGuard = () => Promise<boolean>;
export type RegisterPresetGuard = (guard: PresetLeaveGuard | null) => void;
type TrackDraft = { curve: EnvironmentDraft; percent: string };
function draftsFor(detail: NoisePresetDetail): Record<string, TrackDraft> {
  return Object.fromEntries(
    detail.tracks
      .filter((t) => t.environment)
      .map((t) => [
        t.id,
        {
          curve: createEnvironmentDraft(t),
          percent: String(t.environment!.intensity * 100),
        },
      ]),
  );
}
function trackKey(draft?: TrackDraft) {
  return draft
    ? JSON.stringify([draftKey(draft.curve), draft.percent])
    : "none";
}
function reason(error: unknown) {
  return error instanceof Error ? error.message : String(error);
}

export function NoisePresetEditor({
  client,
  detail,
  busy,
  onSaved,
  onLoad,
  onExport,
  onDuplicate,
  registerGuard,
  onEditState,
  renderMissing,
}: {
  client: LullMediaClient | null;
  detail: NoisePresetDetail;
  busy: boolean;
  onSaved: (detail: NoisePresetDetail) => void;
  onLoad: () => void;
  onExport: () => void;
  onDuplicate: () => void;
  registerGuard: RegisterPresetGuard;
  onEditState: (dirty: boolean, saving: boolean) => void;
  renderMissing?: (disabled: boolean) => ReactNode;
}) {
  useLocale();
  const id = useId();
  const root = useRef<HTMLDivElement>(null);
  const { confirm, dialog } = useConfirmDialog();
  const [name, setName] = useState(detail.preset.name);
  const [description, setDescription] = useState(
    detail.preset.description ?? "",
  );
  const [drafts, setDrafts] = useState(() => draftsFor(detail));
  const [expanded, setExpanded] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [conflict, setConflict] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const writing = useRef(false);
  const alive = useRef(true);
  const request = useRef(0);
  const baseline = draftsFor(detail);
  const changed = detail.tracks.filter(
    (t) => trackKey(drafts[t.id]) !== trackKey(baseline[t.id]),
  );
  const dirty =
    name !== detail.preset.name ||
    description !== (detail.preset.description ?? "") ||
    changed.length > 0;
  const readonly = detail.preset.sourceType === "builtin";
  const state = useRef({ dirty, busy, detail });
  state.current = { dirty, busy, detail };
  const reset = useCallback(() => {
    setName(detail.preset.name);
    setDescription(detail.preset.description ?? "");
    setDrafts(draftsFor(detail));
    setConflict(false);
    setError("");
  }, [detail]);
  useEffect(reset, [reset]);
  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      request.current++;
    };
  }, []);
  useEffect(() => {
    onEditState(dirty, saving);
  }, [dirty, saving, onEditState]);
  useEffect(() => {
    registerGuard(async () => {
      if (writing.current || state.current.busy) return false;
      if (!state.current.dirty) return true;
      return confirm({
        title: m.env_preset_leave_title(),
        description: m.env_preset_leave_hint(),
        confirmLabel: m.env_preset_discard_leave(),
        cancelLabel: m.env_preset_keep_editing(),
      });
    });
    return () => registerGuard(null);
  }, [confirm, registerGuard]);
  const refreshDetail = useCallback(
    async (discard = false) => {
      if (!client) return;
      const token = ++request.current;
      try {
        const next = await client.noise.presets.getPreset(detail.preset.id);
        if (!alive.current || token !== request.current) return;
        if (next.preset.updatedAt < state.current.detail.preset.updatedAt)
          return;
        if (discard || !state.current.dirty) onSaved(next);
        else if (
          next.preset.updatedAt !== state.current.detail.preset.updatedAt
        )
          setConflict(true);
      } catch (e) {
        if (alive.current && token === request.current) setError(reason(e));
      }
    },
    [client, detail.preset.id, onSaved],
  );
  useEffect(() => {
    if (!client) return;
    return client.events.on((event) => {
      if (
        event.topic !== "noise.preset.updated" &&
        event.topic !== "noise.preset.deleted"
      )
        return;
      if (
        (event.payload as { presetId?: string })?.presetId !== detail.preset.id
      )
        return;
      if (writing.current) return;
      if (event.topic === "noise.preset.deleted") {
        setConflict(true);
        setError(m.env_preset_deleted());
        return;
      }
      void refreshDetail();
    });
  }, [client, detail.preset.id, refreshDetail]);
  const focusTrack = (trackId: string) => {
    setExpanded(trackId);
    requestAnimationFrame(() => {
      const section = document.getElementById(`${id}-${trackId}`);
      const target =
        section?.querySelector<HTMLElement>('[aria-invalid="true"]') ??
        section?.querySelector<HTMLElement>("input, button");
      target?.focus();
      target?.scrollIntoView?.({ block: "nearest" });
    });
  };
  const save = async () => {
    if (!client || readonly || writing.current || busy || conflict || !dirty)
      return;
    setError("");
    setNotice("");
    if (!name.trim() || [...name.trim()].length > 80) {
      setError(m.env_preset_name_error());
      root.current
        ?.querySelector<HTMLInputElement>("[data-preset-name]")
        ?.focus();
      return;
    }
    const patches: NonNullable<NoisePresetUpdatePatch["trackEnvironments"]> =
      [];
    for (const track of changed) {
      const draft = drafts[track.id];
      if (
        !draft ||
        percentValue(draft.percent) === null ||
        draft.curve.anchors.length < 2 ||
        draft.curve.anchors.length > 8 ||
        anchorErrors(draft.curve.anchors).some(Boolean)
      ) {
        setError(m.env_preset_invalid());
        focusTrack(track.id);
        return;
      }
      patches.push({
        presetTrackId: track.id,
        environment: serializeDraft(draft.curve, Number(draft.percent) / 100),
      });
    }
    writing.current = true;
    request.current++;
    setSaving(true);
    try {
      for (const patch of patches) {
        try {
          const assets = await Promise.all(
            patch.environment.anchors.map((a) =>
              client.noise.library.getAsset(a.assetId),
            ),
          );
          if (assets.some((a) => a.status !== "available"))
            throw new Error(m.env_missing());
        } catch (e) {
          focusTrack(patch.presetTrackId);
          throw e;
        }
      }
      if (!alive.current) return;
      const next = await client.noise.presets.updatePreset(detail.preset.id, {
        name: name.trim(),
        description: description.trim() || null,
        expectedUpdatedAt: detail.preset.updatedAt,
        ...(patches.length ? { trackEnvironments: patches } : {}),
      });
      if (!alive.current) return;
      onSaved(next);
      setNotice(m.env_preset_saved());
    } catch (e) {
      if (!alive.current) return;
      if (
        typeof e === "object" &&
        e !== null &&
        "code" in e &&
        e.code === "noise.preset.conflict"
      )
        setConflict(true);
      setError(reason(e));
    } finally {
      writing.current = false;
      if (alive.current) setSaving(false);
    }
  };
  const disabled = busy || saving || readonly || !client;
  return (
    <Card ref={root} className="min-w-0" data-testid="noise-preset-editor">
      <CardHeader>
        <CardTitle className="break-words text-base">
          <h3>{m.env_preset_edit_title({ name: detail.preset.name })}</h3>
        </CardTitle>
        {dirty && (
          <output className="text-xs text-amber-700">{m.env_dirty()}</output>
        )}
        {readonly && (
          <div className="space-y-2">
            <p className="text-xs text-muted-foreground">
              {m.env_preset_builtin_hint()}
            </p>
            <Button
              type="button"
              variant="outline"
              disabled={busy || !client}
              onClick={onDuplicate}
            >
              {m.env_preset_duplicate()}
            </Button>
          </div>
        )}
      </CardHeader>
      <CardContent className="min-w-0 space-y-4">
        <div className="grid min-w-0 gap-3 md:grid-cols-2">
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${id}-name`}>{m.env_preset_name()}</Label>
            <input
              data-preset-name
              id={`${id}-name`}
              className="h-9 w-full min-w-0 rounded-md border border-line bg-paper px-3 text-sm"
              value={name}
              disabled={disabled}
              onChange={(e) => {
                setName(e.target.value);
                setNotice("");
              }}
            />
          </div>
          <div className="min-w-0 space-y-1">
            <Label htmlFor={`${id}-description`}>
              {m.env_preset_description()}
            </Label>
            <input
              id={`${id}-description`}
              className="h-9 w-full min-w-0 rounded-md border border-line bg-paper px-3 text-sm"
              value={description}
              disabled={disabled}
              onChange={(e) => {
                setDescription(e.target.value);
                setNotice("");
              }}
            />
          </div>
        </div>
        <div className="min-w-0 space-y-2">
          <h4 className="text-sm font-medium">{m.env_preset_tracks()}</h4>
          <div className="min-w-0 divide-y divide-line rounded-md border border-line">
            {detail.tracks.length === 0 && (
              <p className="p-4 text-sm text-muted-foreground">
                {m.env_preset_empty()}
              </p>
            )}
            {detail.tracks.map((track) => {
              const draft = drafts[track.id];
              const open = expanded === track.id;
              return (
                <div key={track.id} className="min-w-0 p-3">
                  <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm">
                    <span className="min-w-0 flex-1 basis-40 break-words font-medium">
                      {track.expectedName}
                      {track.assetName && track.assetName !== track.expectedName
                        ? `（${track.assetName}）`
                        : ""}
                    </span>
                    <span className="text-xs text-muted-foreground">
                      {m.env_preset_track_volume({
                        value: Math.round(track.volume * 100),
                      })}{" "}
                      ·{" "}
                      {track.enabled
                        ? m.noise_track_enabled()
                        : m.env_preset_disabled()}
                    </span>
                    <span
                      className={
                        track.status === "resolved"
                          ? "text-xs text-emerald-700"
                          : "text-xs text-amber-700"
                      }
                    >
                      {track.status === "resolved"
                        ? m.env_preset_resolved()
                        : m.env_missing()}
                    </span>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      aria-expanded={open}
                      aria-controls={`${id}-${track.id}`}
                      disabled={busy || saving || (readonly && !draft)}
                      onClick={() => {
                        if (!draft)
                          setDrafts((prev) => ({
                            ...prev,
                            [track.id]: {
                              curve: createEnvironmentDraft(track),
                              percent: "50",
                            },
                          }));
                        setExpanded(open ? null : track.id);
                      }}
                    >
                      {open
                        ? m.env_close()
                        : draft
                          ? m.env_open()
                          : m.env_create()}
                    </Button>
                  </div>
                  {draft && (
                    <p className="mt-1 break-words text-xs text-muted-foreground">
                      {m.env_preset_summary({
                        type: environmentTypeLabel(draft.curve.type),
                        value: draft.percent || "—",
                        count: draft.curve.anchors.length,
                      })}
                    </p>
                  )}
                  {open && draft && (
                    <section
                      id={`${id}-${track.id}`}
                      aria-label={track.expectedName}
                      className="mt-3 min-w-0 rounded-md border border-border bg-background p-3"
                    >
                      <NoiseEnvironmentForm
                        client={client}
                        draft={draft.curve}
                        percent={draft.percent}
                        disabled={disabled}
                        onChange={(curve) => {
                          setDrafts((prev) => ({
                            ...prev,
                            [track.id]: { ...prev[track.id], curve },
                          }));
                          setNotice("");
                        }}
                        onPercentChange={(percent) => {
                          setDrafts((prev) => ({
                            ...prev,
                            [track.id]: { ...prev[track.id], percent },
                          }));
                          setNotice("");
                        }}
                      />
                    </section>
                  )}
                </div>
              );
            })}
          </div>
        </div>
        {renderMissing?.(dirty || saving || busy || readonly)}
        {conflict && (
          <div role="alert" className="space-y-2 text-sm text-amber-700">
            <p>{m.env_preset_conflict()}</p>
            <Button
              type="button"
              size="sm"
              variant="outline"
              disabled={saving || busy}
              onClick={() =>
                void confirm({
                  title: m.env_reload(),
                  description: m.env_preset_leave_hint(),
                  confirmLabel: m.env_reload(),
                  cancelLabel: m.env_preset_keep_editing(),
                }).then((ok) => {
                  if (ok) void refreshDetail(true);
                })
              }
            >
              {m.env_reload()}
            </Button>
          </div>
        )}
        {error && (
          <p role="alert" className="break-words text-sm text-destructive">
            {error}
          </p>
        )}
        {notice && (
          <output className="block text-sm text-emerald-700">{notice}</output>
        )}
        <div className="flex flex-wrap gap-2 border-t border-line pt-3">
          <Button
            type="button"
            disabled={disabled || !dirty || conflict}
            onClick={() => void save()}
          >
            {saving ? m.env_saving() : m.env_preset_save()}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || saving || !dirty}
            onClick={
              conflict
                ? () => void refreshDetail(true)
                : () => {
                    reset();
                    setNotice("");
                  }
            }
          >
            {m.env_cancel()}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || saving || dirty || conflict}
            onClick={onLoad}
          >
            {m.noise_preset_load_to_mix()}
          </Button>
          <Button
            type="button"
            variant="outline"
            disabled={busy || saving || dirty || conflict}
            onClick={onExport}
          >
            {m.env_preset_export()}
          </Button>
        </div>
        {dirty && (
          <p className="text-xs text-muted-foreground">
            {m.env_preset_save_first()}
          </p>
        )}
      </CardContent>
      {dialog}
    </Card>
  );
}
