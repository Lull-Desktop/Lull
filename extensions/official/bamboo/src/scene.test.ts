import type { SceneFrame } from "@lull/scene-sdk";
import { beforeEach, describe, expect, test } from "vitest";
import { applyEnvironment, applySceneFrame, canvasFont } from "./scene";

const BAND_IDS = ["mist-band-0", "mist-band-1", "mist-band-2"] as const;
const STALK_IDS = [
  "stalk-0",
  "stalk-1",
  "stalk-2",
  "stalk-3",
  "stalk-4",
  "stalk-5",
] as const;

function setupDom(): void {
  document.body.innerHTML = `
    <div id="scene">
      <div id="moon"></div>
      <div id="fireflies"></div>
      <div id="mist-veil"></div>
      ${BAND_IDS.map((id) => `<div id="${id}" class="mist-band"></div>`).join("")}
      ${STALK_IDS.map(
        (id, index) =>
          `<div id="${id}" class="stalk" data-static-delay="-${index + 1}s"></div>`,
      ).join("")}
      <div id="copy">
        <div class="wordmark"></div>
        <div id="clock"></div>
        <div class="subtitle"></div>
      </div>
      <div id="canvas-label" hidden></div>
    </div>
  `;
}

function frame(overrides: Partial<SceneFrame> = {}): SceneFrame {
  return {
    mode: "mirror",
    layout: "viewport",
    sync: { enabled: false, epochMs: 0 },
    viewport: { w: 1920, h: 1080, dpr: 1 },
    canvas: null,
    view: null,
    dpr: 1,
    params: { mist: 0.5 },
    reducedMotion: false,
    performance: null,
    ...overrides,
  };
}

function styleOf(id: string): CSSStyleDeclaration {
  const node = document.getElementById(id);
  if (!node) throw new Error(`缺少节点 ${id}`);
  return node.style;
}

beforeEach(() => {
  setupDom();
});

describe("竹影 mist 参数", () => {
  test("0 = 无雾，雾幔与三层带雾全部透明", () => {
    applySceneFrame(document, frame({ params: { mist: 0 } }));
    expect(styleOf("mist-veil").opacity).toBe("0");
    for (const id of BAND_IDS) {
      expect(styleOf(id).opacity).toBe("0");
    }
  });

  test("1 = 最浓，雾幔与带雾按声明不透明度叠加", () => {
    applySceneFrame(document, frame({ params: { mist: 1 } }));
    expect(styleOf("mist-veil").opacity).toBe(String(0.62));
    expect(styleOf("mist-band-0").opacity).toBe(String(0.5));
    expect(styleOf("mist-band-1").opacity).toBe(String(0.42));
    expect(styleOf("mist-band-2").opacity).toBe(String(0.34));
    expect(styleOf("mist-band-0").height).toBe("24%");
  });

  test("越界值夹到 0..1，缺失时回退默认 0.5", () => {
    applySceneFrame(document, frame({ params: { mist: 2 } }));
    expect(styleOf("mist-veil").opacity).toBe(String(0.62));
    applySceneFrame(document, frame({ params: { mist: -1 } }));
    expect(styleOf("mist-veil").opacity).toBe("0");
    applySceneFrame(document, frame({ params: {} }));
    expect(styleOf("mist-veil").opacity).toBe(String(0.5 * 0.62));
  });
});

describe("竹影同步相位", () => {
  test("sync.enabled 时用负 animation-delay 对齐月晕/雾带/竹竿", () => {
    applySceneFrame(
      document,
      frame({ sync: { enabled: true, epochMs: 30000 } }),
    );
    expect(styleOf("moon").animationDelay).toBe("-3000ms");
    expect(styleOf("fireflies").animationDelay).toBe("-6000ms");
    expect(styleOf("mist-band-0").animationDelay).toBe("-4000ms");
    expect(styleOf("stalk-0").animationDelay).toBe("-8000ms");
    expect(styleOf("stalk-0").animationDuration).toBe("11s");
  });

  test("不同步时雾带走 0，竹竿回落到静态延迟", () => {
    applySceneFrame(document, frame({ sync: { enabled: false, epochMs: 0 } }));
    expect(styleOf("mist-band-0").animationDelay).toBe("");
    expect(styleOf("stalk-1").animationDelay).toBe("-2s");
  });
});

describe("竹影画布布局", () => {
  test("canvas 下按画布宽度放大字号并显示角落标记", () => {
    applySceneFrame(
      document,
      frame({
        layout: "canvas",
        canvas: { x: 0, y: 0, w: 4480, h: 1440 },
        viewport: { w: 2240, h: 720, dpr: 2 },
      }),
    );
    const scene = document.getElementById("scene");
    expect(scene?.style.getPropertyValue("--wordmark-size")).toBe(
      `${canvasFont(4480, 40)}px`,
    );
    expect(scene?.style.getPropertyValue("--clock-size")).toBe(
      `${canvasFont(4480, 88)}px`,
    );
    const label = document.getElementById("canvas-label");
    expect(label?.hidden).toBe(false);
    expect(label?.textContent).toBe("4480×1440 · CANVAS");
  });

  test("viewport 下恢复基础字号并隐藏角落标记", () => {
    applySceneFrame(
      document,
      frame({
        layout: "canvas",
        canvas: { x: 0, y: 0, w: 4480, h: 1440 },
      }),
    );
    applySceneFrame(document, frame());
    const scene = document.getElementById("scene");
    expect(scene?.style.getPropertyValue("--wordmark-size")).toBe("40px");
    expect(document.getElementById("canvas-label")?.hidden).toBe(true);
  });

  test("reducedMotion 写入根节点供 CSS 停用动画", () => {
    applySceneFrame(document, frame({ reducedMotion: true }));
    expect(document.getElementById("scene")?.dataset.reducedMotion).toBe(
      "true",
    );
  });
});

describe("竹影环境目标", () => {
  test("小雨时保留细雨、雨线速度与风力倾斜", () => {
    applyEnvironment(document, {
      targets: { rain: 0.1, wind: 1 },
      timestamp: 1,
      revision: 1,
    });
    expect(styleOf("scene").getPropertyValue("--sway-angle")).toBe("4deg");
    expect(Number(styleOf("scene").getPropertyValue("--rain-light"))).toBeCloseTo(0.3);
    expect(styleOf("scene").getPropertyValue("--rain-medium")).toBe("0");
    expect(styleOf("scene").getPropertyValue("--rain-heavy")).toBe("0");
    expect(styleOf("scene").getPropertyValue("--rain-tilt")).toBe("-18deg");
    expect(styleOf("scene").getPropertyValue("--rain-light-speed")).toBe("2.08s");
    expect(document.getElementById("scene")?.dataset.raining).toBe("true");
  });

  test("中雨到大雨渐进启用更密、更快的雨层与水面反馈", () => {
    applyEnvironment(document, {
      targets: { rain: 0.45 },
      timestamp: 1,
      revision: 1,
    });
    const medium = Number(styleOf("scene").getPropertyValue("--rain-medium"));
    expect(medium).toBeGreaterThan(0);
    expect(medium).toBeLessThan(1);
    expect(styleOf("scene").getPropertyValue("--rain-heavy")).toBe("0");
    const mediumGap = Number.parseFloat(styleOf("scene").getPropertyValue("--rain-medium-gap-x"));
    expect(mediumGap).toBeLessThan(126);

    applyEnvironment(document, {
      targets: { rain: 0.8 },
      timestamp: 2,
      revision: 2,
    });
    const heavy = Number(styleOf("scene").getPropertyValue("--rain-heavy"));
    expect(heavy).toBeGreaterThan(0);
    expect(heavy).toBeLessThan(1);
    expect(Number.parseFloat(styleOf("scene").getPropertyValue("--rain-heavy-gap-x"))).toBeLessThan(mediumGap);
    expect(styleOf("scene").getPropertyValue("--rain-heavy-speed")).toBe("0.77s");
    expect(styleOf("scene").getPropertyValue("--rain-ambience")).toBe("0.8");
  });

  test("强雨封顶，缺失时重置降雨层与氛围", () => {
    applyEnvironment(document, {
      targets: { rain: 1, wind: 1 },
      timestamp: 1,
      revision: 1,
    });
    expect(styleOf("scene").getPropertyValue("--rain-heavy")).toBe("1");
    expect(styleOf("scene").getPropertyValue("--rain-heavy-speed")).toBe("0.63s");
    expect(styleOf("scene").getPropertyValue("--rain-heavy-length")).toBe("38.0px");

    applyEnvironment(document, {
      targets: { rain: 0.1 },
      timestamp: 2,
      revision: 2,
    });
    expect(styleOf("scene").getPropertyValue("--sway-angle")).toBe("0.7deg");
    expect(
      Number(styleOf("scene").getPropertyValue("--rain-light")),
    ).toBeCloseTo(0.3);
    expect(styleOf("scene").getPropertyValue("--rain-heavy")).toBe("0");
    applyEnvironment(document, { targets: {}, timestamp: 3, revision: 3 });
    expect(styleOf("scene").getPropertyValue("--rain-light")).toBe("0");
    expect(styleOf("scene").getPropertyValue("--rain-medium")).toBe("0");
    expect(styleOf("scene").getPropertyValue("--rain-ambience")).toBe("0");
    expect(document.getElementById("scene")?.dataset.raining).toBe("false");
  });
});
