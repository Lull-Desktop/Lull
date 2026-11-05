/**
 * Ambient Embers · Phaser replica（`entry.replica`）。
 *
 * 一个包同时包含 authority 与 replica；本页只读渲染，使用
 * `@lull/game-adapter-phaser` 把 LULL 生命周期接到 Phaser 的 loop/scale。
 */
import { createPhaserGameAdapter } from "@lull/game-adapter-phaser";
import { connectLullGameRender } from "@lull/game-sdk/scene";
import Phaser from "phaser";

type Ember = { x: number; y: number; size: number; hue: number };

type WorldState = {
  simulationMs?: number;
  phase?: number;
  intensity?: number;
  embers?: Ember[];
};

const REGISTRY_KEY = "lull.world";
/** 即便加载旧存档（旧 seed 相同），三个示例也不共享同一套色相。 */
const HUE_SHIFT = 0;

class EmberScene extends Phaser.Scene {
  private graphics!: Phaser.GameObjects.Graphics;

  constructor() {
    super("embers");
  }

  create(): void {
    this.graphics = this.add.graphics();
  }

  update(time: number): void {
    const world = this.registry.get(REGISTRY_KEY) as WorldState | undefined;
    const graphics = this.graphics;
    const width = this.scale.width;
    const height = this.scale.height;
    graphics.clear();
    if (!world?.embers) return;

    const intensity = world.intensity ?? 0.5;
    const seconds = time / 1000;
    for (const ember of world.embers) {
      const drift = Math.sin(seconds * 0.55 + ember.hue * 0.017) * 0.008;
      const x = (ember.x + drift) * width;
      const y = ember.y * height;
      const radius = 3 + ember.size * 16 * (0.65 + intensity * 0.7);
      const color = Phaser.Display.Color.HSVToRGB(
        ((ember.hue + HUE_SHIFT) % 360) / 360,
        0.52,
        0.55 + intensity * 0.4,
      ).color;
      graphics.fillStyle(color, 0.12 + intensity * 0.16);
      graphics.fillCircle(x, y, radius * 3.2);
      graphics.fillStyle(color, 0.55 + intensity * 0.3);
      graphics.fillCircle(x, y, radius);
    }
  }
}

const stage = document.getElementById("stage");
if (stage) {
  const hint = document.getElementById("hint");
  const game = await connectLullGameRender();
  if (!game) {
    if (hint)
      hint.textContent = "未连接到 LULL 实例：浏览器预览，仅显示静态背景";
  } else {
    if (hint) hint.textContent = "Phaser 3 · 游戏包内置 replica";
    const adapter = createPhaserGameAdapter<Phaser.Game>({
      game,
      create: ({ width, height }) =>
        new Phaser.Game({
          type: Phaser.AUTO,
          parent: "stage",
          width,
          height,
          transparent: true,
          scale: {
            mode: Phaser.Scale.RESIZE,
            autoCenter: Phaser.Scale.CENTER_BOTH,
          },
          scene: [EmberScene],
        }),
      applySnapshot: (runtime, snapshot) => {
        runtime.registry.set(REGISTRY_KEY, snapshot.state as WorldState);
      },
      onError: (error) => console.warn("[phaser-demo]", error),
    });
    await adapter.start();
    window.addEventListener("beforeunload", () => adapter.destroy());
  }
}
