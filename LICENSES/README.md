# License texts

This directory follows the REUSE-style layout: one canonical text per license,
referenced from `NOTICE`, `README.md`, `THIRD_PARTY_NOTICES.md` and the
component-specific license files.

| File | Covers |
| --- | --- |
| `GPL-3.0-or-later.txt` | Lull application code |
| `Apache-2.0.txt` | `src/sdk/**` public interfaces |
| `CC-BY-4.0.txt` | official content, schemas, documentation |
| `OFL-1.1.txt` | bundled fonts (Noto Sans SC, Source Han Serif SC) |

`LICENSE` at the repository root is the GPL-3.0 text used by GitHub license
detection and by the installer (`bundle.licenseFile`).

The font files also carry their own notices:

- `src/assets/fonts/LICENSE_NotoSansSC`
- `src/assets/fonts/LICENSE_SourceHanSerif`
