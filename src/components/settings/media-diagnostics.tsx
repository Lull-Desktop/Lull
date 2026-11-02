"use client";

import type { MediaStats } from "@/core/media/types";
/** 媒体诊断卡片：只读计数，不提供控制。 */
import { m } from "@/paraglide/messages";

export function MediaDiagnostics({ stats }: { stats: MediaStats | null }) {
  if (!stats) return null;
  return (
    <div className="space-y-2 rounded-md border border-border/50 bg-card p-3">
      <p className="text-xs font-medium text-ink-soft">
        {m.media_diagnostics()}
      </p>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs text-muted-foreground">
        <dt>{m.media_diag_sessions()}</dt>
        <dd className="text-right font-mono tabular-nums">{stats.sessions}</dd>
        <dt>{m.media_diag_native()}</dt>
        <dd className="text-right font-mono tabular-nums">
          {stats.nativeSessions}
        </dd>
        <dt>{m.media_diag_fallback()}</dt>
        <dd className="text-right font-mono tabular-nums">
          {stats.fallbackSessions}
        </dd>
        <dt>{m.media_diag_decoders()}</dt>
        <dd className="text-right font-mono tabular-nums">
          {stats.decoderInstances}
        </dd>
        <dt>{m.media_diag_readback()}</dt>
        <dd className="text-right font-mono tabular-nums">
          {stats.cpuReadbackBytes} B
        </dd>
      </dl>
    </div>
  );
}
