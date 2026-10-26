# Skill

Skill packages for AI agents (and developers who prefer the command line). Each subdirectory
is a self-contained skill: one `SKILL.md` (triggers + workflow + standard references) plus an
optional CLI, templates and reference docs.

```text
Skill/
`-- lull-extension/          # create / validate / pack Lull extensions (tool widgets + wallpaper scenes)
    |-- SKILL.md             # what the AI reads
    |-- README.md            # for humans: install (generic skills CLI), commands, config, limits
    |-- skill.json           # skill metadata
    |-- package.json         # npm package (bin: lull-ext)
    |-- bin/  lib/           # CLI implementation (no third-party dependencies)
    |-- references/          # extension standard, SDK reference, design playbook, troubleshooting
    |-- templates/           # widget / scene / scene-static templates
    `-- scripts/self-test.mjs
```

## 30-second start

```bash
# 1) Install the skill (generic Agent Skills standard, several agents at once)
npx skills add Lull-Desktop/Lull --skill lull-extension -y
npx skills add Lull-Desktop/Lull --skill lull-extension --all -g -y   # every agent + user-level
npx skills add ./ --skill lull-extension --copy -y                    # from a local clone

# 2) Compile the SDK (easiest inside the Lull repo; elsewhere drop --from to use remote main)
node .agents/skills/lull-extension/bin/lull-ext.mjs sdk build --from .

# 3) Scaffold a tool extension
node .agents/skills/lull-extension/bin/lull-ext.mjs new widget ./my-tool --id my-tool --name "My tool"
node .agents/skills/lull-extension/bin/lull-ext.mjs validate ./my-tool --strict
node .agents/skills/lull-extension/bin/lull-ext.mjs pack ./my-tool --out ./artifacts
```

After installing, the skill lives in `.claude/skills/lull-extension/` (Claude Code) or
`.agents/skills/lull-extension/` (Cursor / Codex / OpenCode and others share it). Then just say
"create a new wallpaper scene with lull-extension" in the conversation to trigger it.

## Installing for multiple agents

The skill follows the [Agent Skills spec](https://agentskills.io/specification) (`name` /
`description` frontmatter, `name` matches the directory), is discovered by `skills@1.7.4`
directly from the repo, and passes `npx skills-ref validate ./Skill/lull-extension`:

```bash
npx skills add Lull-Desktop/Lull --list                             # should list lull-extension
npx skills add Lull-Desktop/Lull --skill lull-extension -y          # project-level (default)
npx skills add Lull-Desktop/Lull --skill lull-extension --all -g -y # every agent + user-level
npx skills add Lull-Desktop/Lull --skill lull-extension --copy -y \
  -a claude-code -a cursor -a codex
npx skills add ./ --skill lull-extension --copy -y                  # from a local clone
```

| Agent | Project-level | User-level (`-g`) |
| --- | --- | --- |
| Claude Code | `.claude/skills/lull-extension/` | `~/.claude/skills/lull-extension/` |
| Cursor / Codex / OpenCode / Copilot / Cline / Roo / Gemini CLI | `.agents/skills/lull-extension/` | `skills/` under that agent's home |

The whole skill directory is copied (`lib/` `templates/` `references/` `bin/` included); call it
with `node <skill dir>/bin/lull-ext.mjs --help`. On Windows the CLI degrades from symlinks to
copies automatically - pass `--copy` to be explicit. Update with `npx skills update` /
`npx skills check`.

Maintenance constraint: the `SKILL.md` frontmatter may only contain `name` / `description` /
`license` / `compatibility` / `metadata` / `allowed-tools`. Put custom fields (version,
argument-hint, ...) inside `metadata`, otherwise strict cross-agent validators reject the skill.
After editing, run:

```bash
npx --yes skills-ref validate ./Skill/lull-extension
npx --yes skills@1.7.4 add . --list
```

## Source of truth

The standards inside the skill are not a parallel definition; they are the executable version of:

| Content | Source of truth |
| --- | --- |
| widget manifest hard rules | `src-tauri/src/widget_package/manifest.rs` |
| content package (scene) hard rules | `src-tauri/src/content_package/manifest.rs` |
| scene field-level schema | `src/sdk/scene/manifest.ts`, `content/schema/scene.schema.json` |
| artefact and sandbox contract | `docs/widget-sdk.md`, `docs/scene-sdk.md` |
| SDK API | `packages/*/README.md`, `packages/*/src/protocol.ts` |
| digest algorithm | `scripts/content-digest.mjs` |

When any of those change, update `references/*.md` and `lib/validate.mjs`, then run
`node Skill/lull-extension/scripts/self-test.mjs` (it asserts the digest algorithm, the example
packages shipped in the repo, the template chain and the validator's error detection).

## Publishing to npm (maintainers)

```bash
cd Skill/lull-extension
npm pack                 # produces lull-extension-skill-0.1.0.tgz (useful as a release asset)
npm publish              # needs an npm account and rights to the lull-extension-skill name
```

`package.json` `files` already includes `bin` / `lib` / `templates` / `references` / `SKILL.md`,
and `private` is unset, so it publishes as is. If the name is taken, rename it and update the
`npx` examples in `README.md`, `SKILL.md` and this file.
