/**
 * 扩展中心的前端客户端：把 `extensions_*` 命令与稳定的错误结构收敛到一处。
 *
 * 类型与 Rust `src-tauri/src/extension/mod.rs` 的 `ExtensionInfo` /
 * `ExtensionPreview` 一一对应；命令参数用 camelCase，Tauri 会转成 snake_case。
 */
import { invoke } from "@tauri-apps/api/core";

export type ExtensionKind = "scene" | "widget";

export type ExtensionStatus =
  | "ready"
  | "unverified"
  | "tampered"
  | "invalid"
  | "needs-review";

export type ExtensionWindowInfo = {
  width: number;
  height: number;
  chrome: "host" | "custom";
};

export type ExtensionFailure = {
  code: string;
  message: string;
  detail?: string;
};

export type ExtensionInfo = {
  kind: ExtensionKind;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  status: ExtensionStatus;
  verified: "declared" | "computed" | "none";
  dev: boolean;
  error?: ExtensionFailure;
  enabled?: boolean;
  running?: boolean;
  visible?: boolean;
  capabilities?: string[];
  granted?: string[];
  network?: string[];
  window?: ExtensionWindowInfo;
  lifecycle?: "background" | "suspend";
  entryUrl?: string;
  manifest?: unknown;
};

export type ExtensionPreview = {
  kind: ExtensionKind;
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  capabilities: string[];
  network: string[];
  fileCount: number;
  bytes: number;
  sourceDigest: string;
  warnings: string[];
};

export type PickedExtension = {
  path: string;
  preview: ExtensionPreview;
};

export type DevPackage = {
  id: string;
  path: string;
};

export type DevState = {
  devMode: boolean;
  packages: DevPackage[];
};

const UNKNOWN_ERROR: ExtensionFailure = {
  code: "unknown",
  message: "未知错误",
};

/** 把 Rust 的结构化错误或任意 rejection 收敛成可展示的失败。 */
export function toExtensionFailure(error: unknown): ExtensionFailure {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      return {
        code: record.code,
        message: record.message,
        detail: typeof record.detail === "string" ? record.detail : undefined,
      };
    }
  }
  if (error instanceof Error) {
    return { ...UNKNOWN_ERROR, message: error.message };
  }
  return { ...UNKNOWN_ERROR, message: String(error) };
}

export async function listExtensions(): Promise<ExtensionInfo[]> {
  const items = await invoke<ExtensionInfo[]>("extensions_list");
  return Array.isArray(items) ? items : [];
}

export async function inspectExtension(
  path: string,
): Promise<ExtensionPreview> {
  return invoke<ExtensionPreview>("extensions_inspect", { path });
}

export async function pickExtension(): Promise<PickedExtension | null> {
  return invoke<PickedExtension | null>("extensions_pick");
}

export async function installExtension(
  path: string,
  sourceDigest: string,
): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>("extensions_install", { path, sourceDigest });
}

export async function removeExtension(
  kind: ExtensionKind,
  id: string,
): Promise<void> {
  await invoke("extensions_remove", { kind, id });
}

export async function setExtensionEnabled(
  id: string,
  enabled: boolean,
): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>("extensions_set_enabled", { id, enabled });
}

export async function setExtensionCapability(
  id: string,
  capability: string,
  granted: boolean,
): Promise<ExtensionInfo> {
  return invoke<ExtensionInfo>("extensions_set_capability", {
    id,
    capability,
    granted,
  });
}

export async function openExtension(
  kind: ExtensionKind,
  id: string,
): Promise<void> {
  await invoke("extensions_open", { kind, id });
}

export async function closeExtension(id: string): Promise<void> {
  await invoke("extensions_close", { id });
}

export async function stopExtension(id: string): Promise<void> {
  await invoke("extensions_stop", { id });
}

export async function openExtensionsDir(kind: ExtensionKind): Promise<string> {
  return invoke<string>("extensions_open_dir", { kind });
}

export async function getDevState(): Promise<DevState> {
  const state = await invoke<DevState>("extensions_dev_state");
  return state ?? { devMode: false, packages: [] };
}

export async function setDevMode(enabled: boolean): Promise<DevState> {
  const state = await invoke<DevState>("extensions_dev_set_enabled", {
    enabled,
  });
  return state ?? { devMode: enabled, packages: [] };
}

export async function pickDevPackage(): Promise<ExtensionInfo | null> {
  return invoke<ExtensionInfo | null>("extensions_dev_pick_and_add");
}

export async function removeDevPackage(id: string): Promise<void> {
  await invoke("extensions_dev_remove", { id });
}

export async function reloadDevPackage(id: string): Promise<void> {
  await invoke("extensions_dev_reload", { id });
}
