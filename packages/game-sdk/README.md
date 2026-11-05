# `@lull/game-sdk`

Lull 游戏包侧 SDK：authority 入口读取快照、接收命令/tick、提交状态，Controller Widget 读取快照并发送命令，
Scene 场景只读渲染游戏副本。
协议、能力矩阵与完整示例见仓库文档 [`docs/game-sdk.md`](../../docs/game-sdk.md)，宿主侧设计见
[`docs/game-runtime.md`](../../docs/game-runtime.md)。

- authority 客户端：`@lull/game-sdk`
- Controller Widget 客户端：`@lull/game-sdk/widget`
- Scene 只读渲染桥：`@lull/game-sdk/scene`
- 稳定性探针：`@lull/game-sdk/diagnostics`
- 测试辅助：`@lull/game-sdk/testing`

```ts
import { connectLullGame } from "@lull/game-sdk";

const game = await connectLullGame();
const snapshot = await game.getSnapshot();
await game.reportReady();
await game.commitState({ state: { ...snapshot?.state } });
```

```ts
import { connectLullGameWidget } from "@lull/game-sdk/widget";

const game = await connectLullGameWidget(widget, { gameId: "community.living-world" });
const result = await game.command("plant.seed", { seedId: "seed-1" });
```

```ts
import { connectLullGameRender } from "@lull/game-sdk/scene";

const game = await connectLullGameRender();
if (game) {
  game.onSnapshot((snapshot) => draw(snapshot.state, game.render));
}
```

```ts
import { createStabilityProbe } from "@lull/game-sdk/diagnostics";

const probe = createStabilityProbe({ canvas: webglCanvas });
probe.start();
// ... run ...
console.log(JSON.stringify(probe.summary(), null, 2));
```

## 构建

```bash
pnpm game:sdk        # tsc 构建 dist（含 .d.ts / sourcemap）
pnpm game:sdk:check  # 只做类型检查（CI 用）
```

许可：Apache-2.0（见仓库根 `SDK-LICENSE.md`）。
