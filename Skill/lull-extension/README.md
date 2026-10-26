# lull-extension (skill + CLI)

A skill package for building Lull desktop extensions: it fetches and compiles the SDK from
`packages/`, scaffolds, validates and packs tool widgets and wallpaper scenes, and follows the
[Agent Skills spec](https://agentskills.io/specification) so the generic `npx skills add`
can install it into several agents at once.

- Target repo: <https://github.com/Lull-Desktop/Lull>
- Skill instructions: [`SKILL.md`](./SKILL.md)
- Standards: `references/extension-standard.md`, `widget-standard.md`, `scene-standard.md`
- Runtime requirement: Node >= 20

## 1. Install (generic Agent Skills standard)

A skill is a directory containing `SKILL.md` (with `name` matching the directory and a
`description` that says when to use it). This one passes
`npx skills-ref validate ./Skill/lull-extension`, and `skills@1.7.4` discovers it straight
from the repo (`Found 1 skill: lull-extension`).

```bash
# 1) See what the repo offers (writes nothing)
npx skills add Lull-Desktop/Lull --list

# 2) Project-level (default): Claude Code -> .claude/skills/, Cursor/Codex/Copilot etc. -> .agents/skills/
npx skills add Lull-Desktop/Lull --skill lull-extension -y

# 3) Target several agents
npx skills add Lull-Desktop/Lull --skill lull-extension -y \
  -a claude-code -a cursor -a codex -a opencode

# 4) Every agent, user-level (available across projects)
npx skills add Lull-Desktop/Lull --skill lull-extension --all -g -y

# 5) Windows / no-symlink environments: copy instead of link
npx skills add Lull-Desktop/Lull --skill lull-extension --copy -y -a claude-code

# 6) Install from a local clone (no GitHub remote needed)
npx skills add ./ --skill lull-extension --copy -y -a claude-code
```

If your CLI version only looks at a root `skills/` directory, point it at the skill folder
directly:

```bash
npx skills add https://github.com/Lull-Desktop/Lull/tree/main/Skill/lull-extension
```

Where it lands (**the whole directory is copied**: `lib/` `templates/` `references/` `bin/`):

| Agent | Project-level (default) | User-level (`-g`) |
| --- | --- | --- |
| Claude Code | `.claude/skills/lull-extension/` | `~/.claude/skills/lull-extension/` |
| Cursor / Codex / OpenCode / Copilot / Cline / Roo / Gemini CLI | `.agents/skills/lull-extension/` | `skills/` under that agent's home |

The CLI prefers symlinks (one source of truth, `npx skills update` refreshes all of them) and
falls back to copying on Windows; pass `--copy` to be explicit. Companions: `npx skills list`,
`npx skills check`, `npx skills update`, `npx skills remove lull-extension`.

Without the `skills` CLI (offline or restricted), copy the directory into a standard location
the agent scans - the spec only requires "a directory containing `SKILL.md`":

```bash
mkdir -p .agents/skills
cp -r ./Skill/lull-extension .agents/skills/
# then: node .agents/skills/lull-extension/bin/lull-ext.mjs <command>
```

> This skill ships **no installer of its own**. Installing the skill is the job of the generic
> CLI above; `lull-ext` only compiles the SDK and scaffolds / validates / packs extensions.

## 2. Running the CLI

An installed skill exposes no global command, so call it by location - or skip installing and
run it from the package or repo:

```bash
# Installed into an agent directory
node .agents/skills/lull-extension/bin/lull-ext.mjs doctor
node .claude/skills/lull-extension/bin/lull-ext.mjs doctor

# From the npm package (without installing the skill)
npx --yes lull-extension-skill validate ./my-tool
npx --yes lull-extension-skill doctor

# From a local directory / tarball (offline)
npx --yes ./Skill/lull-extension validate ./my-tool
npm pack ./Skill/lull-extension                     # -> lull-extension-skill-0.1.0.tgz
npx --yes ./lull-extension-skill-0.1.0.tgz validate ./my-tool

# Inside the Lull repo (easiest)
node ./Skill/lull-extension/bin/lull-ext.mjs sdk build --from .
```

The installed layout matches the spec exactly - no extra marker files:

```text
<agent>/skills/lull-extension/
  SKILL.md  skill.json  package.json  README.md
  references/  templates/  lib/  bin/  scripts/
```

## 3. Commands

| Command | Purpose |
| --- | --- |
| `doctor` | health check: node / git / npm / cache / SDK artefacts / skill install location / repo detection |
| `sdk build` | fetch `packages/` and compile `@lull/widget-sdk`, `@lull/scene-sdk` |
| `sdk info` | print the last build manifest (source commit, versions, dist digests) |
| `new widget <dir>` | scaffold a tool extension |
| `new scene <dir>` | scaffold a wallpaper scene (script by default, `--static` for a static package) |
| `vendor <dir>` | copy the SDK dist into the extension `vendor/` |
| `hash <bundle>` | recompute the content package `integrity` and write it back to `catalog.json` |
| `validate <dir>` | validate against the extension standard (manifest + artefacts + sandbox rules) |
| `pack <dir>` | pack into an installable zip (content packages recompute integrity first) |

Options:

```
--from <repo>       compile the SDK from a local checkout (offline, most reproducible)
--ref <branch|tag>  remote ref to clone, default main
--out <dir>         SDK output directory / package output directory
--sdk <dir>         SDK directory used by vendor and new
--json              validate / doctor emit JSON
--strict            validate treats warnings as errors
--force             overwrite the generated directory
--no-vendor         new: skip copying the SDK
--no-hash           pack: skip recomputing integrity (not recommended)
```

## 4. Fetch and compile flow (sdk build)

```text
sdk build
  |- Source
  |   |- --from <dir>: verify <dir>/packages/widget-sdk/package.json, read the short HEAD sha
  |   `- default: git clone --depth 1 --filter=blob:none --sparse --branch <ref> into the cache
  |               sparse-checkout set packages          # skip src-tauri / website
  |- Per package (widget-sdk, scene-sdk)
  |   |- find tsc: <pkg>/node_modules/typescript/bin/tsc -> <repo>/node_modules/typescript/bin/tsc
  |   |- neither, and not --offline: npm install inside the package (its devDeps only)
  |   `- node <tsc> -p <pkg>/tsconfig.json              # emits dist/*.js + .d.ts + .map
  |- Verify dist/index.js and dist/index.d.ts exist
  |- Copy to <out>/<pkg>/{package.json,dist,README.md}
  |- Self-check: dynamically import dist/index.js, assert connectLullWidget / connectLullScene
  `- Write <out>/sdk-manifest.json
```

Why not `pnpm widgets:sdk`: that is just a `tsc -p` line, but the repo has no pnpm workspace
(`pnpm-workspace.yaml` only carries `allowBuilds`), and a root `pnpm install` pulls the whole
Next / Tauri dependency set. Each SDK has its own tsconfig and devDependencies, so compiling
per package keeps the dependency surface minimal, works offline and leaves the working tree
untouched.

`sdk-manifest.json`:

```json
{
  "schemaVersion": 1,
  "source": { "mode": "git", "remote": "https://github.com/Lull-Desktop/Lull.git",
              "ref": "main", "commit": "<sha>" },
  "builtAt": "2026-10-26T01:00:00.000Z",
  "node": "22.22.2",
  "packages": [
    { "name": "@lull/widget-sdk", "version": "0.2.0", "dir": "widget-sdk",
      "entry": "widget-sdk/dist/index.js", "types": "widget-sdk/dist/index.d.ts",
      "files": 12, "indexBytes": 0, "distBytes": 0, "digest": "sha256:..." }
  ]
}
```

## 5. Three ways to consume the SDK

| Approach | Good for | How |
| --- | --- | --- |
| **vendor** (default, zero build) | vanilla JS plugins, static scenes | `lull-ext vendor <dir>` copies `dist/*.js` into `vendor/<pkg>/`; import `./vendor/widget-sdk/index.js` |
| `file:` dependency | TypeScript types, unit tests | `npm i --save-dev file:<out>/widget-sdk` |
| Bundler | React / Vue / single-file output | Vite / esbuild resolves `@lull/widget-sdk`, `base: "./"`, one entry HTML |

vendor works because the SDK dist is ESM with relative imports only (`./client.js` and
friends) and the root entry has no bare dependency (React/Vue adapters live in subpaths).
That is also why no import map is needed.

## 6. Configuration

| Name | Type | Default | Meaning |
| --- | --- | --- | --- |
| `LULL_SKILL_CACHE` | env | `~/.lull-skill` | cache root: clones (`src/<ref>`) and SDK artefacts (`sdk`) |
| `LULL_SDK_DIR` | env | `<cache>/sdk` | SDK directory used by `vendor` and `new` |
| `NO_COLOR` | env | - | disable ANSI colors |
| `LULL_EXT_DEBUG` | env | - | print a stack trace on failure |
| `--cache` / `--out` / `--sdk` | flag | as above | override the three settings |
| `--from` / `--ref` / `--refresh` / `--offline` | flag | `main` / off / off | control the SDK source and reuse |

## 7. Input/output and limits

**stdout** carries human progress (prefixes `[info] [ok] [step] [item] [next]`), **stderr**
carries `[warn] [error]`. Exit codes: `0` success, `1` failure (validation/network/directory),
`2` usage error. `validate --json` emits `{ ok, kind, root, id, name, version, entry, errors[],
warnings[], infos[], stats }`, where each diagnostic is `{ code, message, hint? }`.

Refused operations:

- `--offline` without `--from`; a remote fetch without git;
- a non-empty target directory without `--force`;
- a directory that has neither `widget.json` nor `catalog.json`;
- `vendor` before the SDK is built (it tells you to run `sdk build`).

Known limits:

- **No signing**: only a local digest lock (`.lull-integrity.json`, created by the host
  installer when it enables the package).
- **No publishing**: no online catalog, no auto-update, no rollback; the same id overwrites,
  with no downgrade protection.
- **Not a substitute for a real device**: `validate` is static analysis and cannot prove visual,
  performance or transparency behaviour.
- **Does not touch the app**: no changes to `src/` / `src-tauri/`; host capabilities belong in
  the repo code.
- **A vendored SDK ships inside the package**: around 100 KB, counted against the 5 MB budget;
  use `--no-vendor` and a bundler when that matters.

## 8. Directory

```text
lull-extension/
  SKILL.md              # what the AI reads (triggers, workflow, hard rules, troubleshooting)
  README.md             # this file (distribution, commands, configuration, limits)
  skill.json            # skill metadata
  package.json          # npm package (bin: lull-ext)
  bin/lull-ext.mjs      # CLI entry
  lib/                  # cli / sdk / validate / scaffold / pack / digest / zip / util / log
  references/           # extension standard and design playbook
  templates/            # widget / scene / scene-static templates
  scripts/self-test.mjs # self-check: digest, example packages, template chain
```

License: same as the Lull repo, GPL-3.0-or-later; the SDK itself is Apache-2.0 (see
`SDK-LICENSE.md` in the repo).
