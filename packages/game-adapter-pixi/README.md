# @lull/game-adapter-pixi

PixiJS 渲染适配器（P4）。**宿主不加载、不依赖**本包；由游戏包的 `entry.replica` 自己 import 并打包。

它只做三件事：

1. 用 LULL 的渲染几何创建 `Application`，几何/DPI 变化时 `renderer.resize(width, height, dpr)`；
2. 把宿主生命周期映射到 `app.ticker.start()/stop()`；
3. 把只读快照 / 渲染态分发给 `applySnapshot` / `applyRenderState`。

零运行时依赖：不 import PixiJS 类型，用结构化 `PixiApplicationLike`。

```ts
import { Application } from "pixi.js";
import { createPixiGameAdapter } from "@lull/game-adapter-pixi";
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  const adapter = createPixiGameAdapter({
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
      document.getElementById("stage")?.appendChild(app.canvas);
      return app;
    },
    applySnapshot: (app, snapshot) => {
      world.apply(snapshot.state);
    },
  });
  await adapter.start();
}
```

注意：

- **CSP**：LULL 的游戏 CSP 不允许 `unsafe-eval`，PixiJS 8 默认会在初始化时检查并抛
  `Current environment does not allow unsafe-eval`。在 `new Application()` 之前
  `import "pixi.js/unsafe-eval";` —— 该入口用 polyfill 替换掉内部 `new Function`，
  名字虽叫 unsafe-eval，作用恰恰是**不再需要** eval。
- `autoDensity: true` + `resolution: dpr` 才能让 canvas backing store 与显示器 DPI 对齐；
- 适配器不写状态、不发命令；`destroy()` 会退订并 `app.destroy()`。

参考示例：`examples/games/pixi-demo`。
