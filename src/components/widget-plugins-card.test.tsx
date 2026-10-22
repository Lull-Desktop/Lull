import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => {
  const pkg = {
    id: "community-pomodoro",
    name: "番茄钟",
    version: "1.0.0",
    description: "示例",
    status: "ready",
    requested: ["widget.theme", "widget.state"],
    granted: [],
    enabled: false,
    window: {
      width: 560,
      height: 680,
      minWidth: 520,
      minHeight: 620,
      resizable: false,
      transparent: true,
    },
    entryUrl: "http://lullwidget.localhost/community-pomodoro/index.html",
    hostApi: 1,
  };
  return {
    pkg,
    invoke: vi.fn(async (command: string) => {
      if (command === "widget_packages") return [pkg];
      return null;
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({
  invoke: harness.invoke,
}));

import { WidgetPluginsCard } from "./widget-plugins-card";

beforeEach(() => {
  harness.invoke.mockClear();
});

describe("WidgetPluginsCard", () => {
  test("列出插件、能力与授权状态", async () => {
    render(<WidgetPluginsCard />);

    expect(await screen.findByText("番茄钟")).toBeDefined();
    expect(screen.getByText("主题")).toBeDefined();
    expect(screen.getByText("状态")).toBeDefined();
    expect(screen.getByLabelText("番茄钟启用")).toBeDefined();
    expect(
      (screen.getByRole("button", { name: "打开" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });

  test("启用开关调用授权命令", async () => {
    render(<WidgetPluginsCard />);
    const toggle = await screen.findByLabelText("番茄钟启用");

    fireEvent.click(toggle);

    await waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith(
        "widget_package_set_enabled",
        { id: "community-pomodoro", enabled: true },
      );
    });
  });

  test("撤销按钮调用撤销命令", async () => {
    render(<WidgetPluginsCard />);
    const revoke = await screen.findByRole("button", { name: "撤销" });

    fireEvent.click(revoke);

    await waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith("widget_package_revoke", {
        id: "community-pomodoro",
      });
    });
  });
});
