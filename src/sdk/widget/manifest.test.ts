import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import noiseManifest from "@/widgets/manifests/noise.json" with {
  type: "json",
};
import playerManifest from "@/widgets/manifests/player.json" with {
  type: "json",
};
import pomodoroManifest from "@/widgets/manifests/pomodoro.json" with {
  type: "json",
};
import settingsManifest from "@/widgets/manifests/settings.json" with {
  type: "json",
};
import { parseWidgetContext, parseWidgetManifest } from "./manifest";
import { WIDGET_CAPABILITIES } from "./types";

const SHIPPED = [
  settingsManifest,
  playerManifest,
  pomodoroManifest,
  noiseManifest,
];

describe("widget manifest", () => {
  test("随包清单全部可解析，角色与窗口字段完整", () => {
    const manifests = SHIPPED.map((input, index) =>
      parseWidgetManifest(input, `manifest[${index}]`),
    );
    expect(manifests.map((manifest) => manifest.id)).toEqual([
      "settings",
      "player",
      "pomodoro",
      "noise",
    ]);
    expect(manifests.map((manifest) => manifest.role)).toEqual([
      "shell",
      "tool",
      "tool",
      "tool",
    ]);
    const player = manifests.find((manifest) => manifest.id === "player");
    expect(player?.capabilities).toContain("widget.chrome");
    expect(player?.capabilities).toContain("widget.state");
    expect(player?.window.width).toBe(880);
  });

  test("未知能力、越界尺寸与非内置清单会被拒绝", () => {
    expect(() =>
      parseWidgetManifest({
        ...playerManifest,
        capabilities: ["widget.ui", "widget.shell"],
      }),
    ).toThrow(/capabilities/);

    expect(() =>
      parseWidgetManifest({
        ...playerManifest,
        window: { ...playerManifest.window, minWidth: 2000 },
      }),
    ).toThrow(/最小尺寸/);

    expect(() =>
      parseWidgetManifest({ ...playerManifest, builtin: false }),
    ).toThrow(/builtin/);

    expect(() =>
      parseWidgetManifest({ ...playerManifest, role: "plugin" }),
    ).toThrow(/role/);
  });

  test("宿主上下文解析：合法输入归一化，坏数据返回 null", () => {
    const context = parseWidgetContext({
      schemaVersion: 1,
      hostApi: 1,
      id: "player",
      capabilities: ["widget.ui", "widget.chrome"],
      window: playerManifest.window,
    });
    expect(context?.id).toBe("player");
    expect(context?.window.minWidth).toBe(500);

    expect(parseWidgetContext({ id: "player" })).toBeNull();
    expect(
      parseWidgetContext({
        schemaVersion: 1,
        hostApi: 1,
        id: "player",
        capabilities: [],
        window: playerManifest.window,
      }),
    ).toBeNull();
    expect(
      parseWidgetContext({
        schemaVersion: 1,
        hostApi: 1,
        id: "Bad Id",
        capabilities: ["widget.ui"],
        window: playerManifest.window,
      }),
    ).toBeNull();
    expect(
      parseWidgetContext({
        schemaVersion: 1,
        hostApi: 99,
        id: "player",
        capabilities: ["widget.ui"],
        window: playerManifest.window,
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
