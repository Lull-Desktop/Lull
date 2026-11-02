/**
 * 示例包使用全局 `style.css`：iframe 内样式天然隔离，不需要 CSS Modules。
 * 这个 Proxy 让迁移过来的 `styles.root` 等写法保持可读，类名与 CSS 同名。
 */
const styles = new Proxy({} as Record<string, string>, {
  get: (_target, key) => String(key),
});

export default styles;
