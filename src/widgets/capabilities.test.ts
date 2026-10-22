import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "vitest";
import { WINDOW_MANIFESTS } from "./registry";

type GeneratedCapability = {
  identifier: string;
  windows: string[];
  permissions: string[];
};

function capabilityPath(label: string): string {
  return join(
    process.cwd(),
    "src-tauri",
    "capabilities",
    `window-${label}.json`,
  );
}

function readCapability(label: string): GeneratedCapability {
  return JSON.parse(
    readFileSync(capabilityPath(label), "utf8"),
  ) as GeneratedCapability;
}

describe("generated window capabilities", () => {
  test("每个窗口一份 capability，与清单 label 一一对应", () => {
    for (const manifest of WINDOW_MANIFESTS) {
      const label = manifest.window.label;
      const capability = readCapability(label);
      expect(capability.identifier).toBe(`window-${label}`);
      expect(capability.windows).toEqual([label]);
      expect(capability.permissions).toContain("core:default");
    }
  });

  test("设置窗拿宿主管理命令，工具窗只拿自己的窗口帧权限", () => {
    const settings = readCapability("settings");
    expect(settings.permissions).toContain("allow-widget-open");
    expect(settings.permissions).toContain("allow-widget-states");
    expect(settings.permissions).toContain("allow-window-prefs-set");
    expect(settings.permissions).toContain("allow-wallpaper-set-display");

    for (const label of ["player", "pomodoro", "noise"]) {
      const capability = readCapability(label);
      expect(capability.permissions).toContain("allow-window-set-frame");
      expect(capability.permissions).not.toContain("allow-widget-open");
      expect(capability.permissions).not.toContain("allow-widget-states");
      expect(capability.permissions).not.toContain(
        "allow-wallpaper-set-display",
      );
    }
  });

  test("旧版单文件 capability 已移除", () => {
    expect(
      existsSync(
        join(process.cwd(), "src-tauri", "capabilities", "desktop.json"),
      ),
    ).toBe(false);
  });
});
