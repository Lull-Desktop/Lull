# Shadertoy 导入

## 1. 这是什么

把 Shadertoy 上的公开 Shader 导入成本地的 **Shader Content Item**，之后就能在壁纸设置里选中它渲染。

链路分三层，职责不重叠：

| 层 | 在哪 | 做什么 | 不做什么 |
| --- | --- | --- | --- |
| Import Widget（`shadertoy-importer`） | 扩展包，`widget-*` 窗口 | 搜索、看详情、发起导入、管理已导入项、填 API Key | 不联网、不读 Key、不写文件 |
| Widget Bridge | 宿主壳页 + `shadertoy_call` / `job_*` 命令 | 校验 capability、转发请求、转发任务事件 | 不理解业务语义 |
| Import Service（Rust） | `src-tauri/src/shadertoy/` | 调 Shadertoy API、注入 Key、下载资源、规范化、打包、写入内容库 | 不碰窗口生命周期 |
| Host Job Manager（Rust） | `src-tauri/src/jobs/` | 任务状态、取消标记、事件推送、结果保留 | 不认识具体业务 |

交付边界只有一个：**Content Item**（见 [shader-item.md](./shader-item.md)）。Widget 不直接产出文件，Scene 也不知道 Item 从哪来。

## 2. 如何使用

### 2.1 配置 API Key

扩展中心 → 着色器导入 → 设置 → 填 Shadertoy API Key → 保存 → 测试连接。

- Key 由宿主保管，Windows 上用 DPAPI（当前用户）加密后存在 `<app_data>/shadertoy/api-key.bin`；
- Widget 与 Scene 都拿不到 Key，请求由 Rust 代发；
- 便携版可用环境变量 `LULL_SHADERTOY_API_KEY` 覆盖，环境变量优先且不落盘；
- 换 Windows 用户或换机器后密文解不开，需要重新填写。

### 2.2 导入

1. 「发现」页搜索关键词（留空看热门）；
2. 结果列表只显示名字、作者、ID、Pass 数量——**搜索不等于可导入**；
3. 点「导入」后宿主创建任务，依次走 `fetching → validating → downloading → packaging → registering`；
4. 进度来自宿主任务事件，关掉 Widget 任务照旧进行，重开后会按 `jobId` 恢复显示；
5. 成功后内容项进入 Shader Library，壁纸设置 → 着色器 → 内容 里就能选中。

### 2.3 管理

「Shader 库」页列出已导入的内容项，可以删除。正在作为壁纸使用的项不允许删除（先换内容）。

## 3. 注意与限制

- **只支持一部分 Shader**：纹理与 buffer 输入可以导入；键盘、音乐、视频、Webcam、Cubemap 输入会被拒绝，并给出具体原因（`unsupported.input` / `unsupported.pass` / `unsupported.no-image`）。
- **资源必须本地化**：Shader 引用的纹理会被下载进内容项（PNG / JPEG / WebP，按魔数校验，单张上限 16 MiB）；下载失败的资源不会被静默跳过，整个导入失败。
- **Buffer 精度按 32F 声明**：Shadertoy 的 buffer 是浮点缓冲；拿不到 `EXT_color_buffer_float` 时渲染器会自己降级到半浮点并在控制台告警。
- **许可保持 `unknown`**：Shadertoy API 不返回许可证，导入项只声明"本地可用"，不代表可以再分发。`source` 里保留原作者、原始 ID 与链接。
- **不是扩展安装**：内容项没有入口 HTML、没有脚本执行面、不进场景下拉、不参与启用/卸载。
- **不做跨重启续传**：任务只活在宿主生命周期内；重启应用后进行中的任务不会恢复（已完成的项不受影响）。
- **重复导入会覆盖**：同一个 Shader 再次导入时按 id 覆盖旧内容项（先备份再换入），版本号由宿主维护。
- **不伪造进度**：只有资源下载阶段能算出可信百分比，其余阶段只报阶段名。

## 4. 故障排查

| 现象 | 含义 | 处理 |
| --- | --- | --- |
| `api.no-key` | 没有配置 Key | 设置页填 Key 并「测试连接」 |
| `api.unauthorized` | Key 无效或无权限 | 重新生成 Key |
| `api.rate-limited` | 触发 Shadertoy 配额 | 稍后再试，不要连续重试 |
| `api.timeout` / `api.network` | 网络不可达或超时（20s） | 检查代理/DNS |
| `unsupported.*` | 该 Shader 用了首版不支持的输入类型 | 无法导入，属能力边界 |
| `package.*` | 生成的包没通过内容校验 | 报 bug，附 Shader ID |
| `library.in-use` | 内容项正在被壁纸使用 | 先在壁纸设置换内容再删 |
