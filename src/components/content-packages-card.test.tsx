import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, test, vi } from "vitest";

const harness = vi.hoisted(() => {
  const ready = {
    id: "community.mist",
    name: "雾岚",
    version: "1.0.0",
    description: "薄雾与远山",
    author: "Lull Community",
    license: "CC-BY-4.0",
    status: "ready",
    entryUrl:
      "http://lullcontent.localhost/community.mist/scenes/mist/index.html",
    verified: true,
    manifest: { id: "community.mist" },
  };
  const tampered = {
    ...ready,
    id: "community.broken",
    name: "坏包",
    status: "tampered",
    verified: false,
    error: "内容包摘要不匹配",
  };
  return {
    ready,
    tampered,
    invoke: vi.fn(async (command: string) => {
      if (command === "content_packages") return [ready, tampered];
      if (command === "content_open_dir") return "C:\\Users\\test\\content";
      return null;
    }),
  };
});

vi.mock("@tauri-apps/api/core", () => ({ invoke: harness.invoke }));
vi.mock("@tauri-apps/api/window", () => ({
  getCurrentWindow: () => ({
    onDragDropEvent: () => Promise.resolve(() => {}),
  }),
}));
vi.mock("@/core/window/controls", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/core/window/controls")>()),
  isDesktopWindow: () => true,
}));

import { ContentPackagesCard } from "./content-packages-card";

beforeEach(() => {
  harness.invoke.mockClear();
});

describe("ContentPackagesCard", () => {
  test("列出内容包并标注校验状态", async () => {
    render(<ContentPackagesCard />);

    expect(await screen.findByText("雾岚")).toBeDefined();
    expect(screen.getByText("已校验")).toBeDefined();
    expect(screen.getByText("坏包")).toBeDefined();
    expect(screen.getByText("摘要不符")).toBeDefined();
    expect(screen.getByText("内容包摘要不匹配")).toBeDefined();
  });

  test("卸载需要二次确认", async () => {
    render(<ContentPackagesCard />);
    const buttons = await screen.findAllByRole("button", { name: "卸载" });
    const first = buttons[0];
    if (!first) throw new Error("没有卸载按钮");

    fireEvent.click(first);
    expect(harness.invoke).not.toHaveBeenCalledWith(
      "content_package_remove",
      expect.anything(),
    );
    expect(screen.getByRole("button", { name: "确认卸载" })).toBeDefined();

    fireEvent.click(screen.getByRole("button", { name: "确认卸载" }));
    await waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith("content_package_remove", {
        id: "community.mist",
      });
    });
  });

  test("打开内容目录命令回显路径", async () => {
    render(<ContentPackagesCard />);
    const open = await screen.findByRole("button", { name: "内容目录" });

    fireEvent.click(open);
    await waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith("content_open_dir");
    });
    expect(await screen.findByText(/C:\\Users\\test\\content/)).toBeDefined();
  });

  test("选择 zip 走原生选择器命令（不依赖拖拽）", async () => {
    render(<ContentPackagesCard />);
    const pick = await screen.findByRole("button", { name: "选择 zip" });

    fireEvent.click(pick);

    await waitFor(() => {
      expect(harness.invoke).toHaveBeenCalledWith(
        "content_package_pick_and_install",
        { folder: false },
      );
    });
    expect(await screen.findByText("已取消选择")).toBeDefined();
  });
});
