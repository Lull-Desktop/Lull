import { expect, test } from "vitest";
import type { SceneParamDefinition } from "./manifest";
import { resolveSceneParams } from "./params";

const DEFS: SceneParamDefinition[] = [
  {
    key: "density",
    type: "number",
    label: "密度",
    default: 0.5,
    min: 0,
    max: 1,
  },
  { key: "enabled", type: "boolean", label: "启用", default: true },
  {
    key: "tone",
    type: "enum",
    label: "色调",
    default: "warm",
    options: [
      { value: "warm", label: "暖" },
      { value: "cool", label: "冷" },
    ],
  },
  { key: "color", type: "color", label: "颜色", default: "#112233" },
  { key: "label", type: "string", label: "标签", default: "默认" },
];

test("applies defaults when no stored values exist", () => {
  expect(resolveSceneParams(DEFS, undefined)).toEqual({
    density: 0.5,
    enabled: true,
    tone: "warm",
    color: "#112233",
    label: "默认",
  });
});

test("coerces stored strings and clamps numbers", () => {
  expect(
    resolveSceneParams(DEFS, {
      density: "2",
      enabled: "false",
      tone: "cool",
      color: "#abcdef",
      label: "自定义",
    }),
  ).toEqual({
    density: 1,
    enabled: false,
    tone: "cool",
    color: "#abcdef",
    label: "自定义",
  });
});

test("invalid stored values fall back to defaults", () => {
  expect(
    resolveSceneParams(DEFS, {
      density: "abc",
      enabled: "yes",
      tone: "hot",
      color: "red",
    }),
  ).toEqual({
    density: 0.5,
    enabled: true,
    tone: "warm",
    color: "#112233",
    label: "默认",
  });
});

test("ignores unknown stored keys", () => {
  expect(resolveSceneParams(DEFS, { unknown: "x" })).not.toHaveProperty(
    "unknown",
  );
});
