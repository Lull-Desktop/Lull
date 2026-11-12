/**
 * 内置默认着色器：宿主没有下发源码（从未填写，或在参数面板点了「恢复默认」）时
 * 用它顶上，避免壁纸一片空白。
 *
 * 事实源是 `fixtures/default.frag`（Shadertoy「The Drive Home」）：构建时通过 Vite
 * 的 `?raw` 把原文内联进场景 JS，`fixtures/` 目录本身仍然不进入构建产物。第三方
 * 素材授权见仓库根目录的 `THIRD_PARTY_NOTICES.md`。
 */
import DEFAULT_SOURCE_TEXT from "../../fixtures/default.frag?raw";

/** 默认示例的显示名；只用于日志与文档，不参与渲染。 */
export const DEFAULT_SHADER_NAME = "The Drive Home";

/** 默认示例源码（与 fixture 文件逐字一致）。 */
export const DEFAULT_SHADER_SOURCE: string = DEFAULT_SOURCE_TEXT;
