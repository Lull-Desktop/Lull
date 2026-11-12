/**
 * Vite `?raw` 导入的类型声明：默认返回文件原文（构建时内联为字符串）。
 *
 * 仓库没有引入 `vite/client` 类型（扩展内只有这一处用到 `?raw`），所以在这里
 * 声明最小的模块形状，让 `pnpm typecheck` 与编辑器都能识别。
 */
declare module "*?raw" {
  const content: string;
  export default content;
}
