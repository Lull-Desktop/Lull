# 鼠标光晕（`wallpaper.pointer` 示例）

演示 Scene SDK 的鼠标位置通道：**只接收移动状态与坐标**，点击、双击、右键
仍由桌面自己处理，壁纸不拦截任何输入。

## 文件

```text
pointer-demo/
  catalog.json                 # demo.pointer-scene 1.0.0（hostApi 3）
  item.json                    # 社区目录元数据
  scenes/pointer-demo/
    index.html                 # 场景页面
    main.js                    # 由 src/main.ts 构建（已提交，便于直接安装）
  src/main.ts                  # onPointer 用法示例
```

清单要求：

- `wallpaper.script` + `wallpaper.pointer` 必须同时声明；
- `compatibility.hostApi >= 3`。

## SDK 用法

```ts
import { connectLullScene } from "@lull/scene-sdk";

const scene = await connectLullScene();
scene.onPointer((pointer) => {
  // pointer.x / pointer.y：场景绘制坐标系内的 CSS 像素
  // pointer.inside：光标在桌面层上且落在本场景内
  // pointer.moving：最近约 120ms 内是否有移动
  halo.style.transform = `translate(${pointer.x}px, ${pointer.y}px)`;
});
```

没有 `click` / `dblclick` / `mousedown` 事件，也没有按键、滚轮或修饰键字段。

## 重新构建

```powershell
pnpm scenes:sdk              # 先生成 @lull/scene-sdk/dist
pnpm scenes:samples:build    # 构建 main.js
pnpm scenes:samples:hash     # 内容变了必须重算 catalog.json 的 integrity
```

## 安装与验收

```powershell
pnpm scenes:samples:pack
# 产物：artifacts/demo.pointer-scene-1.0.0.zip
```

设置 → 扩展 → 从文件安装；安装后在「壁纸」页选择「鼠标光晕（脚本场景）」。

1. 移动鼠标：光晕跟随；静止约 120ms 后变暗、缩小。
2. 鼠标移到任务栏、设置窗或其他应用：光晕淡出，不再更新。
3. 单击/双击桌面图标、右键桌面：桌面行为完全正常，光晕不会因点击而触发反馈。
4. span 模式下各屏共用画布坐标，光晕能跨屏跟随。

> 该包声明 `wallpaper.script`，运行在 `sandbox="allow-scripts"` 的 opaque-origin iframe。
> 它读不到宿主 DOM、Tauri IPC 或存储，唯一输入是 Scene SDK 的只读桥。
