/**
 * 宿主兼容层的尺寸贴合出口：确认请求真的带着宽高与停靠锚点发给宿主，
 * 而不是在桥未安装时静默吃掉（那样窗口会停在清单里的初始宽度）。
 */
import type { LullWidgetClient } from "@lull/widget-sdk";
import { expect, test } from "vitest";
import { installNoiseBridge, widgetRequestResize } from "./compat";

type ResizeOptions = {
  width?: number;
  height?: number;
  anchor?: "left" | "right";
};

function install(requestResize: (options: ResizeOptions) => Promise<unknown>): {
  calls: ResizeOptions[];
} {
  const calls: ResizeOptions[] = [];
  const widget = {
    requestResize: (options: ResizeOptions) => {
      calls.push(options);
      return requestResize(options);
    },
  } as unknown as LullWidgetClient;
  // 媒体客户端这一层用不到，占位即可。
  installNoiseBridge(widget, {} as never);
  return { calls };
}

test("贴宽请求带上宽高与停靠锚点", async () => {
  const { calls } = install(() =>
    Promise.resolve({ width: 181, height: 392, dpr: 1, applied: true }),
  );
  await widgetRequestResize({ width: 181, height: 392, anchor: "right" });
  expect(calls).toEqual([{ width: 181, height: 392, anchor: "right" }]);
});

test("宿主拒绝时不抛错，布局流程不会被打断", async () => {
  const { calls } = install(() => Promise.reject(new Error("未获得权限")));
  await expect(
    widgetRequestResize({ width: 181, height: 392, anchor: "left" }),
  ).resolves.toBeUndefined();
  expect(calls).toHaveLength(1);
});
