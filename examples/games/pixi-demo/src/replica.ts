/**
 * Ambient Embers · PixiJS replica（`entry.replica`）。
 *
 * 一个包同时包含 authority 与 replica；本页只读渲染，使用
 * `@lull/game-adapter-pixi` 把 LULL 生命周期接到 Application 的 ticker / renderer。
 *
 * `pixi.js/unsafe-eval` 是 PixiJS 的 CSP 兼容入口：它把内部用 `new Function`
 * 生成的 uniform/UBO/shader 同步代码换成 polyfill。LULL 的游戏 CSP 不允许
 * `unsafe-eval`，所以必须先 import 它（名字相反，作用是不再需要 eval）。
 */
import "pixi.js/unsafe-eval";
import { createPixiGameAdapter } from "@lull/game-adapter-pixi";
import { connectLullGameRender } from "@lull/game-sdk/scene";
import { Application, Container, Graphics } from "pixi.js";

type Ember = { x: number; y: number; size: number; hue: number };

type WorldState = {
  simulationMs?: number;
  phase?: number;
  intensity?: number;
  embers?: Ember[];
};

function hslToRgb(hue: number, saturation: number, lightness: number): number {
  const c = (1 - Math.abs(2 * lightness - 1)) * saturation;
  const hp = (((hue % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  const [r, g, b] =
    hp < 1
      ? [c, x, 0]
      : hp < 2
        ? [x, c, 0]
        : hp < 3
          ? [0, c, x]
          : hp < 4
            ? [0, x, c]
            : hp < 5
              ? [x, 0, c]
              : [c, 0, x];
  const m = lightness - c / 2;
  const channel = (value: number): number =>
    Math.max(0, Math.min(255, Math.round((value + m) * 255)));
  return (channel(r) << 16) | (channel(g) << 8) | channel(b);
}

const world: WorldState = { intensity: 0.5, embers: [] };
const stage = document.getElementById("stage");
const hint = document.getElementById("hint");

const game = stage ? await connectLullGameRender() : null;
if (!game) {
  if (hint) hint.textContent = "未连接到 LULL 实例：浏览器预览，仅显示静态背景";
} else {
  const adapter = createPixiGameAdapter<Application>({
    game,
    create: async ({ width, height, dpr }) => {
      const app = new Application();
      await app.init({
        width,
        height,
        resolution: dpr,
        autoDensity: true,
        antialias: true,
        backgroundAlpha: 0,
        preference: "webgl",
      });
      stage?.appendChild(app.canvas as HTMLCanvasElement);

      const field = new Container();
      const graphics = new Graphics();
      field.addChild(graphics);
      app.stage.addChild(field);

      app.ticker.add(() => {
        const seconds = performance.now() / 1000;
        const width = app.screen.width;
        const height = app.screen.height;
        const intensity = world.intensity ?? 0.5;
        graphics.clear();
        for (const ember of world.embers ?? []) {
          const drift = Math.sin(seconds * 0.55 + ember.hue * 0.017) * 0.008;
          const x = (ember.x + drift) * width;
          const y = ember.y * height;
          const radius = 3 + ember.size * 16 * (0.65 + intensity * 0.7);
          const color = hslToRgb(ember.hue, 0.55, 0.35 + intensity * 0.3);
          graphics
            .circle(x, y, radius * 3.2)
            .fill({ color, alpha: 0.1 + intensity * 0.14 });
          graphics
            .circle(x, y, radius)
            .fill({ color, alpha: 0.5 + intensity * 0.35 });
        }
      });
      return app;
    },
    applySnapshot: (_app, snapshot) => {
      const state = snapshot.state as WorldState;
      world.intensity = state.intensity ?? world.intensity;
      if (Array.isArray(state.embers) && state.embers.length > 0) {
        world.embers = state.embers;
      }
    },
    onError: (error) => console.warn("[pixi-demo]", error),
  });
  await adapter.start();
  if (hint) hint.textContent = "PixiJS 8 · 游戏包内置 replica";
  window.addEventListener("beforeunload", () => adapter.destroy());
}
