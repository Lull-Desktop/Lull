# Liquid 番茄钟示例

从内置 Liquid 番茄钟迁移出来的**普通 Widget 扩展**，不随应用分发，需要手动安装。

```powershell
pnpm widgets:samples:build
pnpm widgets:samples:install
```

然后到设置 → 扩展启用「番茄钟（Liquid）」。也可以只打包这一份：

```powershell
pnpm widget:pack examples/widgets/liquid-pomodoro/dist
```

说明：

- 只依赖 `@lull/widget-sdk`，不访问宿主 `@/` 或 Tauri IPC。
- 偏好通过 SDK KV 保存；旧内置版的 localStorage 偏好不会自动迁移。
- 示例包用全局 `style.css`（iframe 内隔离），`src/styles.ts` 保留 `styles.foo` 写法。
- 清单声明 `window.fit: "content"`，宿主会在第一次贴高后显示窗口。
