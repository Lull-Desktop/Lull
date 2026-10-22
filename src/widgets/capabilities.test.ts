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

  test("生产 CSP 已启用，包含 Tauri IPC 与 dev CSP", () => {
    const config = JSON.parse(
      readFileSync(join(process.cwd(), "src-tauri", "tauri.conf.json"), "utf8"),
    ) as {
      app: { security: { csp?: string; devCsp?: string } };
    };
    const csp = config.app.security.csp ?? "";
    expect(csp).not.toBe("");
    expect(csp).toContain("default-src 'self'");
    expect(csp).toContain("connect-src 'self' ipc: http://ipc.localhost");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("media-src 'self' blob:");
    expect(config.app.security.devCsp ?? "").toContain("ws://localhost:3000");
  });

  test("插件窗口 capability 只给自身状态与窗口操作", () => {
    const capability = JSON.parse(
      readFileSync(
        join(process.cwd(), "src-tauri", "capabilities", "window-widgets.json"),
        "utf8",
      ),
    ) as GeneratedCapability;
    expect(capability.windows).toEqual(["widget-*"]);
    expect(capability.permissions).toContain("core:event:allow-listen");
    expect(capability.permissions).toContain("allow-widget-package-notify");
    expect(capability.permissions).not.toContain("core:event:allow-emit");
    expect(capability.permissions).toContain("allow-widget-state-get");
    expect(capability.permissions).toContain("allow-widget-set-transparent");
    expect(capability.permissions).toContain("core:window:allow-hide");
    expect(capability.permissions).not.toContain("core:default");
    expect(capability.permissions).not.toContain("allow-widget-packages");
    expect(capability.permissions).not.toContain("allow-wallpaper-set-display");
  });
});
