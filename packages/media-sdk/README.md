# @lull/media-sdk

Lull Media Service 的 TypeScript 客户端。

## 官方窗口

```ts
import { createMediaClient } from "@lull/media-sdk";

const media = createMediaClient();
await media.connect({ topics: ["noise.session.changed"] });
const session = await media.noise.session.getCurrent();
await media.noise.tracks.add("noise:builtin:rain");
await media.noise.session.play();
```

Tauri 环境自动使用 `media_call` / `media_connect`；测试传入 `transport`。

## Widget

插件需在 `widget.json` 声明 `widget.media` 与需要的 Noise capability（见
`docs/widget-sdk.md`），并由用户授权。插件只通过宿主 iframe 桥访问媒体，
拿不到 Tauri IPC 或 bridge token。

```ts
import { connectLullWidget } from "@lull/widget-sdk";
import { createWidgetMediaClient } from "@lull/media-sdk/widget";

const lull = await connectLullWidget();
const media = createWidgetMediaClient({
  request: (method, params) => lull.request(method as never, params as never),
  onMediaEvent: lull.onMediaEvent,
});
await media.connect({ topics: ["noise.session.changed"] });
```

## React

```tsx
import { LullMediaProvider, useNoiseSession } from "@lull/media-sdk/react";

function Mixer() {
  const session = useNoiseSession();
  return <span>{session?.state ?? "idle"}</span>;
}
```

Hooks 按 client 共享一次 `connect`；最后一个订阅卸载时 disconnect。
`useNoiseLibrary` / `useNoisePresets` 提供列表、loading/error 与 refresh。

## 音乐库 P4

```ts
const tags = await media.library.listTags();
await media.library.setTrackTags(trackId, [tags[0].id]);
const updated = await media.library.updateTrackMetadata({
  trackId,
  title: "新标题",
  artists: ["Artist A", "Artist B"],
  genre: null,
});
const smart = await media.library.createSmartPlaylist("夜间氛围", {
  genre: "Ambient",
  favoriteOnly: true,
});
const page = await media.library.runSmartPlaylist(smart.id);
```

元数据编辑写 `overrides_json` 与 `field_sources(manual)`；重扫不会覆盖人工字段。
合并/拆分为 `mergeArtists` / `splitArtist` / `mergeAlbums` / `splitAlbum`。

## 约定

- 结果/事件不包含文件路径或 `storage_key`。
- 每个 domain 有独立 revision；事件过滤用对应 domain 的 revision。
- `media.disconnect` 会清理该窗口的订阅；Widget token 无效时 Rust 拒绝媒体调用。
