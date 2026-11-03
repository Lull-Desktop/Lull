import { expect, test } from "vitest";
import { BUILTIN_PROFILE_COPY, profileDescription } from "./smart-shuffle";

test("内置配置文案覆盖三个预设", () => {
  expect(BUILTIN_PROFILE_COPY["builtin:balanced"]?.label).toBe("均衡随机");
  expect(BUILTIN_PROFILE_COPY["builtin:random"]?.label).toBe("高度随机");
  expect(BUILTIN_PROFILE_COPY["builtin:diverse"]?.label).toBe("多样性优先");
  expect(profileDescription("builtin:balanced")).toContain("兼顾");
  expect(profileDescription("user:1")).toBe("自定义听感参数。");
});
