import { describe, expect, test, vi } from "vitest";

const mocks = vi.hoisted(() => ({ listen: vi.fn(), invoke: vi.fn(), unlisten: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ invoke: mocks.invoke }));
vi.mock("@tauri-apps/api/event", () => ({ listen: mocks.listen }));
vi.mock("@/core/window-label", () => ({ hasTauriRuntime: () => true, currentWindowLabel: () => "wallpaper-1" }));
import { isEnvironmentSnapshot, listenWallpaperEnvironment } from "./environment-stream";

describe("壁纸环境状态流", () => {
  test("监听先于查询，延迟返回的旧快照不能覆盖新事件，退订后不再接收", async () => {
    let handler: (event: { payload: unknown }) => void = () => {};
    let resolveSnapshot: (value: unknown) => void = () => {};
    mocks.listen.mockImplementation(async (_name, cb) => { handler = cb; return mocks.unlisten; });
    mocks.invoke.mockImplementation(() => new Promise(resolve => { resolveSnapshot = resolve; }));
    const seen: number[] = [];
    const off = listenWallpaperEnvironment(s => seen.push(s.revision));
    await vi.waitFor(() => expect(mocks.invoke).toHaveBeenCalled());
    handler({ payload: { targets: { wind: 0.8 }, timestamp: 2, revision: 2 } });
    resolveSnapshot({ targets: { wind: 0.1 }, timestamp: 1, revision: 1 });
    await Promise.resolve();
    expect(seen).toEqual([2]);
    off();
    handler({ payload: { targets: {}, timestamp: 3, revision: 3 } });
    expect(seen).toEqual([2]);
    expect(mocks.unlisten).toHaveBeenCalled();
  });
  test("拒绝无效目标", () => {
    expect(isEnvironmentSnapshot({ targets: { rain: NaN }, timestamp: 1, revision: 0 })).toBe(false);
    expect(isEnvironmentSnapshot({ targets: { rain: 1.1 }, timestamp: 1, revision: 0 })).toBe(false);
    expect(isEnvironmentSnapshot({ targets: {}, timestamp: 1, revision: 0 })).toBe(true);
  });
});
