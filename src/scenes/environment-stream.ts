/** 只读环境目标：先监听再查询，并以 revision 解决快照与事件竞态。 */
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { currentWindowLabel, hasTauriRuntime } from "@/core/window-label";
import type { EnvironmentSnapshot } from "./scene-bridge";

export function isEnvironmentSnapshot(value: unknown): value is EnvironmentSnapshot {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const s = value as Record<string, unknown>;
  return !!s.targets && typeof s.targets === "object" && !Array.isArray(s.targets)
    && Object.values(s.targets).every(v => typeof v === "number" && Number.isFinite(v) && v >= 0 && v <= 1)
    && typeof s.timestamp === "number" && Number.isFinite(s.timestamp)
    && typeof s.revision === "number" && Number.isSafeInteger(s.revision) && s.revision >= 0;
}

export function listenWallpaperEnvironment(callback: (snapshot: EnvironmentSnapshot) => void): () => void {
  if (!hasTauriRuntime()) return () => {};
  const label = currentWindowLabel();
  if (!label?.startsWith("wallpaper-")) return () => {};
  let disposed = false;
  let unlisten: UnlistenFn | undefined;
  let revision = -1;
  const accept = (value: unknown) => {
    if (disposed || !isEnvironmentSnapshot(value) || value.revision < revision) return;
    revision = value.revision;
    callback(value);
  };
  void (async () => {
    try {
      unlisten = await listen<unknown>("wallpaper-environment", event => accept(event.payload), { target: { kind: "AnyLabel", label } });
      if (disposed) { unlisten(); return; }
      accept(await invoke<unknown>("wallpaper_environment_snapshot"));
    } catch (error) {
      if (!disposed) console.warn("[scene] 环境状态连接失败", error);
    }
  })();
  return () => { disposed = true; unlisten?.(); };
}
