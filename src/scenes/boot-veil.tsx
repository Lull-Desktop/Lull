/**
 * 壁纸启动幕：第一份 HTML 就存在的静态遮罩层。
 *
 * 它不依赖场景目录、WebView 首帧或字体加载完成；壁纸窗口一显示，用户先看到的是
 * 一层与场景同色系的暗幕与品牌字，而不是黑屏/默认小视口/场景替换。场景就绪后
 * 由父组件把 `hidden` 置为 true，CSS 负责 700ms 淡出（reduced-motion 下瞬时消失）。
 *
 * 注意：它只能遮住 WebView 内部的内容闪动，遮不住原生窗口/WebView 子窗的尺寸跳变；
 * 后者的修复在 `src-tauri` 的挂载路径上。
 */
type BootVeilProps = {
  hidden: boolean;
};

export function BootVeil({ hidden }: BootVeilProps) {
  return (
    <div
      data-testid="wallpaper-boot-veil"
      data-state={hidden ? "hidden" : "visible"}
      aria-hidden="true"
      className="wallpaper-boot-veil"
    >
      <div className="wallpaper-boot-veil__glow" />
      <div className="wallpaper-boot-veil__mark">
        <span className="wallpaper-boot-veil__wordmark">LULL</span>
        <span className="wallpaper-boot-veil__subtitle">
          云栖之处，安然入眠
        </span>
      </div>
      <span className="wallpaper-boot-veil__line" />
    </div>
  );
}
