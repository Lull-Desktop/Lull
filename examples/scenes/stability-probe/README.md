# Stability Probe 指标墙（场景）

只读渲染 `community.stability-probe` 的 self-loop / WebGL 统计，用于 P3 的双屏
mirror/span 验收。

## 先安装游戏

```bash
pnpm games:samples:build
pnpm games:samples:pack
# 在扩展中心安装 examples/games/release/community.stability-probe-1.0.1.lull-game.zip
# 启用后，在设置页「游戏」启动 community.stability-probe
```

## 安装场景

```bash
pnpm content:hash --bundle examples/scenes/stability-probe
pnpm content:pack examples/scenes/stability-probe --out artifacts
# 在扩展中心安装 artifacts 下的 .zip
```

在两块显示器的壁纸设置里都选择「Stability Probe · 指标墙」，场景会声明
`game: { id: "community.stability-probe", role: "replica" }`。游戏已启用且运行时，
壁纸会显示每个 replica 的 `displayId/mode/revision` 与最新统计；未运行时显示等待提示。

> 游戏包本身只有 authority 入口，不会自动出现在壁纸：P2 的显示路径是
> scene manifest 的 `game` 绑定；`entry.replica` 独立入口属于 P4，尚未落地。
