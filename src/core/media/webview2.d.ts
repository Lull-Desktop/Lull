/**
 * WebView2 注入的顶层帧媒体 token 与 TextureStream JS 入口。
 *
 * 这些不是公开 Web 标准；只用于 Lull 自己的壁纸顶层页面。外部场景 iframe 运行在
 * opaque-origin sandbox 中，不能读取父页面的 token。
 */

type LullWebView2TextureStreamOptions = {
  getTextureStream?: (streamId: string) => Promise<MediaStream>;
};

interface LullWebView2Chrome {
  webview?: LullWebView2TextureStreamOptions;
}

interface Window {
  __LULL_MEDIA_TOKEN__?: string;
  /** 壁纸窗顶层帧的游戏 replica token；沙箱场景 iframe 读不到父 DOM。 */
  __LULL_GAME_TOKEN__?: string;
  chrome?: LullWebView2Chrome;
}
