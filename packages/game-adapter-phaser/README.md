# @lull/game-adapter-phaser

Phaser 渲染适配器（P4）。**宿主不加载、不依赖**本包；由游戏包的 `entry.replica` 自己 import 并打包。

它只做三件事：

1. 用 LULL 的渲染几何（`render.viewport`）创建 `Phaser.Game`，之后几何变化时同步 `scale.resize`；
2. 把宿主生命周期映射到 `game.loop.sleep()/wake()`（`suspended`/`stopped`/`failed` 暂停，`resumed`/`running` 恢复）；
3. 把只读快照 / 渲染态分发给 `applySnapshot` / `applyRenderState`。

零运行时依赖：不 import Phaser 类型，用结构化 `PhaserGameLike`；Phaser 的版本由你的包决定。

```ts
import Phaser from "phaser";
import { createPhaserGameAdapter } from "@lull/game-adapter-phaser";
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  const adapter = createPhaserGameAdapter({
    game,
    create: ({ width, height, dpr }) => {
      const runtime = new Phaser.Game({
        type: Phaser.AUTO,
        parent: "stage",
        width,
        height,
        scale: { mode: Phaser.Scale.NONE },
        scene: [MyScene],
      });
      runtime.registry.set("dpr", dpr);
      return runtime;
    },
    applySnapshot: (runtime, snapshot) => {
      runtime.scene.getScene("MyScene")?.applyLullSnapshot(snapshot.state);
    },
  });
  await adapter.start();
}
```

注意：

- Phaser 3 的 Scale Manager 以 **CSS 像素**为基准，不直接吃 `devicePixelRatio`；需要更高清时可自行用 `zoom`/自定义渲染尺寸，或改用 PixiJS / Three.js。
- 适配器不写状态、不发命令、不创建窗口；游戏规则仍在你自己的 scene 里。
- `start()` 只创建引擎；`destroy()` 取消订阅并 `game.destroy(true)`。

参考示例：`examples/games/phaser-demo`。
