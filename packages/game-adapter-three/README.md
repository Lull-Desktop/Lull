# @lull/game-adapter-three

Three.js 渲染适配器（P4）。**宿主不加载、不依赖**本包；由游戏包的 `entry.replica` 自己 import 并打包。

Three.js 没有自带主循环，所以适配器负责：

1. 用 LULL 的渲染几何设置 `renderer.setPixelRatio(dpr)` / `renderer.setSize(w, h, false)`；
2. 用 `requestAnimationFrame` 驱动 `renderer.render(scene, camera)`，按 `maxFps` 节流；
3. 宿主 `suspended`/`stopped`/`failed` 时停帧，`resumed`/`running` 时恢复；
4. 把只读快照 / 渲染态分发给 `applySnapshot` / `applyRenderState`。

零运行时依赖：不 import Three.js 类型，用结构化 `ThreeRendererLike` / `ThreeEngineLike`。

```ts
import * as THREE from "three";
import { createThreeGameAdapter } from "@lull/game-adapter-three";
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  const adapter = createThreeGameAdapter({
    game,
    create: ({ width, height, dpr }) => {
      const renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true });
      renderer.setPixelRatio(dpr);
      renderer.setSize(width, height, false);
      document.getElementById("stage")?.appendChild(renderer.domElement);
      const scene = new THREE.Scene();
      const camera = new THREE.PerspectiveCamera(55, width / height, 0.1, 100);
      return { renderer, scene, camera };
    },
    applySnapshot: (engine, snapshot) => {
      world.apply(snapshot.state);
    },
    onFrame: (engine, timestamp) => {
      world.tick(timestamp);
    },
    maxFps: 30,
  });
  await adapter.start();
}
```

注意：

- `setSize(w, h, false)` 不写内联样式，尺寸由 CSS 控制，避免重连后页面被撑开；
- 渲染连续抛错时适配器会停帧并通过 `onError` 上报，不会无限刷屏；
- 适配器不写状态、不发命令；`destroy()` 会取消 rAF、退订并 `renderer.dispose()`。

参考示例：`examples/games/three-demo`。
