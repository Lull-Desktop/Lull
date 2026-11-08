import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import type { DesktopPointerSample } from "./pointer";
import {
  listenWallpaperPointer,
  WALLPAPER_POINTER_EVENT,
} from "./pointer-stream";

const listen = vi.hoisted(() => vi.fn());

vi.mock("@tauri-apps/api/event", () => ({ listen }));

type TestWindow = Window & {
  __TAURI_INTERNALS__?: {
    metadata?: { currentWindow?: { label?: string } };
  };
};

const testWindow = window as TestWindow;

beforeEach(() => {
  listen.mockReset();
  listen.mockResolvedValue(() => {});
  delete testWindow.__TAURI_INTERNALS__;
});

afterEach(() => {
  delete testWindow.__TAURI_INTERNALS__;
  vi.restoreAllMocks();
});

describe("壁纸鼠标位置事件订阅", () => {
  test("非 Tauri 环境不注册监听", () => {
    const off = listenWallpaperPointer(() => {});
    expect(listen).not.toHaveBeenCalled();
    off();
  });

  test("Tauri 内按当前窗口 label 定向监听并校验载荷", () => {
    testWindow.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "wallpaper-1" } },
    };
    const received: DesktopPointerSample[] = [];
    const off = listenWallpaperPointer((sample) => {
      received.push(sample);
    });

    expect(listen).toHaveBeenCalledWith(
      WALLPAPER_POINTER_EVENT,
      expect.any(Function),
      { target: { kind: "AnyLabel", label: "wallpaper-1" } },
    );

    const handler = listen.mock.calls[0]?.[1] as
      | ((event: { payload: unknown }) => void)
      | undefined;
    handler?.({ payload: { x: 10, y: 20, overDesktop: true, moving: true } });
    handler?.({
      payload: { x: "bad", y: 20, overDesktop: true, moving: true },
    });
    expect(received).toEqual([
      { x: 10, y: 20, overDesktop: true, moving: true },
    ]);
    off();
  });

  test("Tauri 内缺 label 时拒绝全局监听", () => {
    testWindow.__TAURI_INTERNALS__ = { metadata: {} };
    const error = vi.spyOn(console, "error").mockImplementation(() => {});

    const off = listenWallpaperPointer(() => {});

    expect(listen).not.toHaveBeenCalled();
    expect(error).toHaveBeenCalled();
    off();
  });

  test("卸载后才解码的 unlisten 会被立即释放", async () => {
    testWindow.__TAURI_INTERNALS__ = {
      metadata: { currentWindow: { label: "wallpaper-1" } },
    };
    const unlisten = vi.fn();
    let resolveListen: (off: () => void) => void = () => {};
    listen.mockReturnValue(
      new Promise<() => void>((resolve) => {
        resolveListen = resolve;
      }),
    );

    const off = listenWallpaperPointer(() => {});
    off();
    resolveListen(unlisten);
    await Promise.resolve();
    await Promise.resolve();

    expect(unlisten).toHaveBeenCalled();
  });
});
