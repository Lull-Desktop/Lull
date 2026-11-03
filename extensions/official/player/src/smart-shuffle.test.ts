import { DEFAULT_SMART_SHUFFLE_CONFIG } from "@lull/media-sdk";
import { expect, test } from "vitest";
import {
  applySmartShufflePreset,
  SMART_SHUFFLE_PRESETS,
  smartShufflePresetId,
  smartShuffleUserJson,
} from "./smart-shuffle";

test("默认配置匹配均衡随机预设", () => {
  expect(smartShufflePresetId(DEFAULT_SMART_SHUFFLE_CONFIG)).toBe("balanced");
  expect(SMART_SHUFFLE_PRESETS[0]?.experience).toEqual({
    randomness: 60,
    diversity: 50,
    repeatAvoidance: 80,
  });
});

test("预设只替换听感参数并保留 audioFeatures", () => {
  const diverse = SMART_SHUFFLE_PRESETS.find((item) => item.id === "diverse");
  if (!diverse) throw new Error("缺少多样性预设");
  const next = applySmartShufflePreset(
    {
      ...DEFAULT_SMART_SHUFFLE_CONFIG,
      audioFeatures: {
        ...DEFAULT_SMART_SHUFFLE_CONFIG.audioFeatures,
        bpmMatching: 77,
      },
    },
    diverse,
  );
  expect(next.experience).toEqual({
    randomness: 40,
    diversity: 100,
    repeatAvoidance: 90,
  });
  expect(next.separation).toEqual({ artist: 6, album: 4 });
  expect(next.audioFeatures.bpmMatching).toBe(77);
  expect(smartShufflePresetId(next)).toBe("diverse");
});

test("参数不匹配任何预设时判定为自定义", () => {
  const custom = {
    ...DEFAULT_SMART_SHUFFLE_CONFIG,
    experience: {
      ...DEFAULT_SMART_SHUFFLE_CONFIG.experience,
      randomness: 61,
    },
  };
  expect(smartShufflePresetId(custom)).toBe("custom");
});

test("复制 JSON 不包含尚未生效的 audioFeatures", () => {
  const json = smartShuffleUserJson(DEFAULT_SMART_SHUFFLE_CONFIG);
  const parsed = JSON.parse(json) as Record<string, unknown>;
  expect(parsed.version).toBe(1);
  expect(parsed.experience).toEqual({
    randomness: 60,
    diversity: 50,
    repeatAvoidance: 80,
  });
  expect(parsed.separation).toEqual({ artist: 3, album: 2 });
  expect(parsed.audioFeatures).toBeUndefined();
  expect(json).not.toContain("bpmMatching");
});
