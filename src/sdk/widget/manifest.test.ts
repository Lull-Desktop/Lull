import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import libraryManifest from "@/widgets/manifests/library.json" with {
  type: "json",
};
import settingsManifest from "@/widgets/manifests/settings.json" with {
  type: "json",
};
import { parseWidgetContext, parseWidgetManifest } from "./manifest";
import { WIDGET_CAPABILITIES } from "./types";

const SHIPPED = [settingsManifest, libraryManifest];

describe("widget manifest", () => {
  test("随包清单全部可解析，角色与窗口字段完整", () => {
    const manifests = SHIPPED.map((input, index) =>
      parseWidgetManifest(input, `manifest[${index}]`),
    );
    expect(manifests.map((manifest) => manifest.id)).toEqual([
      "settings",
      "library",
    ]);
    expect(manifests.map((manifest) => manifest.role)).toEqual([
      "shell",
      "tool",
    ]);
    const library = manifests.find((manifest) => manifest.id === "library");
    expect(library?.capabilities).toContain("widget.chrome");
    expect(library?.capabilities).toContain("widget.state");
    expect(library?.window.width).toBe(1080);
  });

  test("未知能力、越界尺寸与非内置清单会被拒绝", () => {
    expect(() =>
      parseWidgetManifest({
        ...libraryManifest,
        capabilities: ["widget.ui", "widget.shell"],
      }),
    ).toThrow(/capabilities/);

    expect(() =>
      parseWidgetManifest({
        ...libraryManifest,
        window: { ...libraryManifest.window, minWidth: 2000 },
      }),
    ).toThrow(/最小尺寸/);

    expect(() =>
      parseWidgetManifest({ ...libraryManifest, builtin: false }),
    ).toThrow(/builtin/);

    expect(() =>
      parseWidgetManifest({ ...libraryManifest, role: "plugin" }),
    ).toThrow(/role/);
  });

  test("宿主上下文解析：合法输入归一化，坏数据返回 null", () => {
    const context = parseWidgetContext({
      schemaVersion: 1,
      hostApi: 1,
      id: "player",
      capabilities: ["widget.ui", "widget.chrome"],
      window: libraryManifest.window,
    });
    expect(context?.id).toBe("player");
    expect(context?.window.minWidth).toBe(900);

    expect(parseWidgetContext({ id: "player" })).toBeNull();
    expect(
      parseWidgetContext({
        schemaVersion: 1,
        hostApi: 1,
        id: "player",
        capabilities: [],
        window: libraryManifest.window,
      }),
    ).toBeNull();
    expect(
      parseWidgetContext({
        schemaVersion: 1,
        hostApi: 1,
        id: "Bad Id",
        capabilities: ["widget.ui"],
        window: libraryManifest.window,
      }),
    ).toBeNull();
    expect(
      parseWidgetContext({
        schemaVersion: 1,
        hostApi: 99,
        id: "player",
        capabilities: ["widget.ui"],
        window: libraryManifest.window,
      }),
    ).toBeNull();
  });

  test("Rust 构建脚本的能力白名单与 SDK 枚举一致", () => {
    const source = readFileSync(
      join(process.cwd(), "src-tauri", "build.rs"),
      "utf8",
    );
    const block =
      source.match(/const CAPABILITIES: &\[&str\] = &\[([\s\S]*?)\];/)?.[1] ??
      "";
    const rustCapabilities = [...block.matchAll(/"([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(rustCapabilities).toEqual([...WIDGET_CAPABILITIES]);
  });
});
