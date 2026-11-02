# Content License

Lull separates **application code** from **official content**. This keeps the
desktop application copyleft while letting themes, scenes and examples travel
more easily.

## 1. Official content: CC BY 4.0

The following are licensed under **Creative Commons Attribution 4.0
International**:

- `public/content/**` — catalog, signature keys and the bundled content root
- `examples/scenes/**` — external scene sample packages
- `content/schema/**` — JSON Schema for manifests/catalogs
- `content/README.md`

See [`LICENSES/CC-BY-4.0.txt`](LICENSES/CC-BY-4.0.txt).

Attribution example:

```text
“流萤” scene package from Lull, licensed CC BY 4.0.
https://github.com/<your-repo>/tree/master/examples/scenes/demo-fireflies
```

## 2. Built-in scenes are application code

The host only compiles the media wallpaper (`src/scenes/video`), which is part of the
application and is **GPL-3.0-or-later**, not CC BY 4.0.

The Bamboo wallpaper now lives in `extensions/official/bamboo/**` as a bundled official
scene extension. It is still application code shipped under **GPL-3.0-or-later**, not
CC BY 4.0. Aurora and Dusk were removed and are no longer distributed.

## 3. Third-party content

Third-party scene/theme/sound packages may use any license, but must:

- declare a `license` field in the manifest;
- include the license text or a durable link;
- avoid terms that add restrictions to the Lull application itself;
- avoid non-commercial/no-derivative terms if the content is bundled into an
  official GPL installer.

The catalog displays the declared license, author and version. Lull does not
relicense third-party content.

## 4. Assets inside a package

Content authors are responsible for the fonts, images, audio and other assets
they ship. Do not include assets you cannot redistribute. If a package bundles
an OFL font, include the OFL notice.

## 5. No trademark grant

CC BY 4.0 does not grant permission to use the Lull name or logo as a brand.
See [`TRADEMARK.md`](TRADEMARK.md).
