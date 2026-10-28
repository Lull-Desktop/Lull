import { describe, expect, test } from "vitest";
import { toUserSceneEntries, type UserContentPackage } from "./user-content";

function manifest() {
  return {
    schemaVersion: 1,
    type: "scene",
    id: "community.test",
    name: "测试场景",
    version: "1.0.0",
    description: "单元测试用内容包",
    author: "Lull Community",
    license: "CC-BY-4.0",
    capabilities: ["wallpaper.viewport"],
    entry: "scenes/test/index.html",
    theme: { background: "#0a1416", accent: "#9fc7c2" },
    compatibility: { hostApi: 1, platforms: ["windows"] },
    integrity: {
      algorithm: "sha256",
      scope: "package",
      digest:
        "f6b86e63434d810099e293bfa74c556542a02fbe96fc7ce97390e0938a608ecb",
    },
  };
}

function pkg(overrides: Partial<UserContentPackage> = {}): UserContentPackage {
  return {
    id: "community.test",
    name: "测试场景",
    version: "1.0.0",
    status: "ready",
    entryUrl:
      "http://lullcontent.localhost/community.test/scenes/test/index.html",
    verified: true,
    signature: {
      status: "verified",
      decision: "allow",
      keyId: "279aff591d2627ed",
    },
    manifest: manifest(),
    ...overrides,
  };
}

describe("toUserSceneEntries", () => {
  test("已校验的包转成 user 来源的目录条目", () => {
    const result = toUserSceneEntries([pkg()]);
    expect(result.issues).toEqual([]);
    expect(result.entries).toHaveLength(1);
    expect(result.entries[0]?.source).toBe("user");
    expect(result.entries[0]?.manifest.id).toBe("community.test");
    expect(result.entries[0]?.entryUrl).toContain("/scenes/test/index.html");
    expect(result.entries[0]?.component).toBeNull();
  });

  test("未校验的包仍可用，但要给出提示", () => {
    const result = toUserSceneEntries([pkg({ verified: false })]);
    expect(result.entries).toHaveLength(1);
    expect(result.issues.join()).toContain("来源无法确认");
  });

  test("摘要不符与清单无效的包被跳过", () => {
    const result = toUserSceneEntries([
      pkg({
        id: "community.tampered",
        status: "tampered",
        error: "摘要不匹配",
      }),
      pkg({ id: "community.broken", status: "invalid", error: "缺少 license" }),
    ]);
    expect(result.entries).toHaveLength(0);
    expect(result.issues).toHaveLength(2);
    expect(result.issues.join()).toContain("摘要不匹配");
    expect(result.issues.join()).toContain("缺少 license");
  });

  test("清单字段不合法时不进入目录", () => {
    const broken = { ...manifest(), id: "Bad ID" };
    const result = toUserSceneEntries([pkg({ manifest: broken })]);
    expect(result.entries).toHaveLength(0);
    expect(result.issues.join()).toContain("清单不合法");
  });

  test("缺少入口地址时跳过而不是渲染空 iframe", () => {
    const result = toUserSceneEntries([pkg({ entryUrl: "" })]);
    expect(result.entries).toHaveLength(0);
    expect(result.issues.join()).toContain("缺少入口地址");
  });
});
