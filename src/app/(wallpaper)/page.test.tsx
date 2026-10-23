/**
 * 壁纸页测试：验证哈希参数解析、场景选择、跨屏画布布局与外部内容包挂载。
 */
import { render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, test, vi } from "vitest";
import Page from "./page";

beforeEach(() => {
  window.location.hash = "";
  vi.useRealTimers();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

test("default (empty hash) renders bamboo in viewport layout", () => {
  render(<Page />);
  expect(screen.getByTestId("scene-bamboo")).toBeDefined();
  expect(screen.queryByTestId("canvas-container")).toBeNull();
});

test("startup veil stays visible until the scene reports its first paint", () => {
  render(<Page />);
  const veil = screen.getByTestId("wallpaper-boot-veil");
  // jsdom 里没有真实合成帧；rAF 尚未回调，启动幕应保持可见。
  expect(veil.getAttribute("data-state")).toBe("visible");
});

test("span hash renders canvas container with transform numbers", () => {
  window.location.hash =
    "#mode=span&sync=1&scene=lull.bamboo&canvas=-2560,0,4480,1440&view=0,0,1920,1080";
  render(<Page />);
  const container = screen.getByTestId("canvas-container");
  // jsdom dpr = 1；view 相对画布原点偏移 +2560 ⇒ 容器左移 -2560。
  expect(container.style.width).toBe("4480px");
  expect(container.style.height).toBe("1440px");
  expect(container.style.left).toBe("-2560px");
  expect(container.style.top).toBe("0px");
});

test("unknown scene id falls back to the default bamboo scene", () => {
  window.location.hash = "#scene=nope";
  render(<Page />);
  expect(screen.getByTestId("scene-bamboo")).toBeDefined();
});

test("hashchange switches scene and canvas without reload", async () => {
  render(<Page />);
  expect(screen.getByTestId("scene-bamboo")).toBeDefined();
  window.location.hash =
    "#mode=span&scene=lull.aurora&canvas=-2560,0,4480,1440&view=-2560,0,2560,1440";
  window.dispatchEvent(new HashChangeEvent("hashchange"));
  expect(await screen.findByTestId("scene-aurora")).toBeDefined();
  const container = screen.getByTestId("canvas-container");
  expect(container.style.left).toBe("0px");
});

test("span with sync=0 still anchors phases (forced sync)", () => {
  vi.useFakeTimers();
  vi.setSystemTime(1234);
  window.location.hash =
    "#mode=span&sync=0&scene=lull.aurora&canvas=0,0,1920,1080&view=0,0,1920,1080";
  render(<Page />);
  const band = screen.getByTestId("band-a");
  expect(band.style.animationDelay).toBe("-1234ms");
});

test("bamboo carries its moon glow and stalk layer", () => {
  // 回归：默认场景必须有可见光源与竹林层次，不能只剩渐变底。
  render(<Page />);
  const moon = screen.getByTestId("bamboo-moon");
  expect(moon.className).toContain("bg-[radial-gradient");
  expect(moon.className).toContain("lull-breath");
  expect(screen.getByTestId("bamboo-stalk-0")).toBeDefined();
});

test("external catalog scene mounts in a sandboxed iframe", async () => {
  const payload = JSON.stringify({
    schemaVersion: 1,
    scenes: [
      {
        schemaVersion: 1,
        type: "scene",
        id: "community.mist",
        name: "雾岚",
        version: "1.0.0",
        license: "CC-BY-4.0",
        capabilities: ["wallpaper.viewport", "wallpaper.canvas"],
        entry: "scenes/mist/index.html",
        integrity: {
          algorithm: "sha256",
          scope: "package",
          digest: "c".repeat(64),
        },
      },
    ],
  });
  // 未签名目录（缺少 catalog.sig.json）也要能加载，只是标记来源不可校验。
  vi.stubGlobal(
    "fetch",
    vi.fn((input: RequestInfo | URL) => {
      const url = String(input);
      if (url === "/content/catalog.json") {
        return Promise.resolve({
          ok: true,
          status: 200,
          text: () => Promise.resolve(payload),
        });
      }
      return Promise.resolve({
        ok: false,
        status: 404,
        text: () => Promise.resolve(""),
      });
    }),
  );
  window.location.hash = "#scene=community.mist";
  render(<Page />);
  const frame = await screen.findByTestId("external-scene");
  // 首版外部内容包不执行脚本：空 sandbox 是安全边界，不是占位符。
  expect(frame.getAttribute("sandbox")).toBe("");
  expect(frame.getAttribute("src")).toContain(
    "/content/scenes/mist/index.html",
  );
});
