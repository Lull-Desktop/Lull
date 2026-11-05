import { expect, test } from "vitest";
import type { ExtensionInfo } from "@/lib/extensions";
import {
  categoryOf,
  countExtensions,
  filterExtensions,
  kindForCategory,
} from "./categories";

function extension(kind: ExtensionInfo["kind"], id: string): ExtensionInfo {
  return {
    kind,
    id,
    name: id,
    version: "1.0.0",
    status: "ready",
    verified: "none",
    signature: { status: "unsigned", decision: "warn" },
    dev: false,
  };
}

const items: ExtensionInfo[] = [
  extension("widget", "tool"),
  extension("scene", "wallpaper"),
  extension("game", "game-a"),
  extension("game", "game-b"),
];

test("three categories map to backend kinds", () => {
  expect(categoryOf("widget")).toBe("tool");
  expect(categoryOf("scene")).toBe("wallpaper");
  expect(categoryOf("game")).toBe("game");
  expect(categoryOf("native")).toBeNull();
  expect(kindForCategory("tool")).toBe("widget");
  expect(kindForCategory("wallpaper")).toBe("scene");
  expect(kindForCategory("game")).toBe("game");
});

test("each category filters independently and all keeps every item", () => {
  expect(filterExtensions(items, "all")).toHaveLength(4);
  expect(filterExtensions(items, "tool").map((item) => item.id)).toEqual([
    "tool",
  ]);
  expect(filterExtensions(items, "wallpaper").map((item) => item.id)).toEqual([
    "wallpaper",
  ]);
  expect(filterExtensions(items, "game").map((item) => item.id)).toEqual([
    "game-a",
    "game-b",
  ]);
});

test("counts include games and unknown kinds only count toward all", () => {
  expect(countExtensions(items)).toEqual({
    all: 4,
    tool: 1,
    wallpaper: 1,
    game: 2,
  });

  const unknown = {
    ...extension("game", "native"),
    kind: "native" as ExtensionInfo["kind"],
  };
  expect(countExtensions([unknown])).toEqual({
    all: 1,
    tool: 0,
    wallpaper: 0,
    game: 0,
  });
  expect(filterExtensions([unknown], "game")).toHaveLength(0);
  expect(filterExtensions([unknown], "all")).toHaveLength(1);
});
