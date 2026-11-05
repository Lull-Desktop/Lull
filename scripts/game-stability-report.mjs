#!/usr/bin/env node
/**
 * 采集 Game Runtime 稳定性报告所需的本地事实：
 * - Windows 显示器拓扑（DeviceName / 主屏 / bounds）
 * - `%APPDATA%\app.lull.desktop\games.json` 与 `display.json`
 * - `game-data/<gameId>/<instanceId>/metadata.json` 的最近状态
 * - journal 行数与最近事件类型
 *
 * 运行时计数（ticks/commits/lease）在应用内通过 `game_runtime_diagnostics`
 * 获取（设置页「复制诊断」），本脚本不启动应用。
 *
 * 用法：
 *   node scripts/game-stability-report.mjs
 *   node scripts/game-stability-report.mjs --out report.md
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const args = process.argv.slice(2);
const outIndex = args.indexOf("--out");
const outPath = outIndex >= 0 ? args[outIndex + 1] : null;

function readJson(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return null;
  }
}

function windowsDisplays() {
  if (process.platform !== "win32") return [];
  const script = [
    "Add-Type -AssemblyName System.Windows.Forms",
    "[System.Windows.Forms.Screen]::AllScreens | ForEach-Object {",
    '  "{0}|{1}|{2}|{3}|{4}|{5}" -f $_.DeviceName, $_.Primary,',
    "    $_.Bounds.X, $_.Bounds.Y, $_.Bounds.Width, $_.Bounds.Height",
    "}",
  ].join("\n");
  try {
    const output = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NoLogo", "-Command", script],
      { encoding: "utf8", timeout: 15_000 },
    );
    return output
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [deviceName, primary, x, y, width, height] = line.split("|");
        return {
          deviceName,
          primary: primary === "True",
          x: Number(x),
          y: Number(y),
          width: Number(width),
          height: Number(height),
        };
      });
  } catch {
    return [];
  }
}

function appData() {
  return process.env.APPDATA
    ? join(process.env.APPDATA, "app.lull.desktop")
    : null;
}

function instanceRows(root) {
  if (!root || !existsSync(root)) return [];
  const rows = [];
  for (const game of readdirSync(root, { withFileTypes: true })) {
    if (!game.isDirectory()) continue;
    const gameDir = join(root, game.name);
    for (const instance of readdirSync(gameDir, { withFileTypes: true })) {
      if (!instance.isDirectory()) continue;
      const dir = join(gameDir, instance.name);
      const metadata = readJson(join(dir, "metadata.json"));
      const journalPath = join(dir, "journal.ndjson");
      let journalLines = 0;
      let lastEventTypes = [];
      if (existsSync(journalPath)) {
        const lines = readFileSync(journalPath, "utf8")
          .split(/\r?\n/)
          .filter(Boolean);
        journalLines = lines.length;
        for (const line of lines.slice(-20)) {
          try {
            const entry = JSON.parse(line);
            lastEventTypes.push(...(entry.eventTypes ?? []));
          } catch {
            // journal 只用于诊断，坏行跳过。
          }
        }
      }
      rows.push({
        gameId: metadata?.gameId ?? game.name,
        instanceId: metadata?.instanceId ?? instance.name,
        status: metadata?.status ?? "unknown",
        revision: metadata?.revision ?? 0,
        authorityEpoch: metadata?.authorityEpoch ?? 0,
        simulationTimeMs: metadata?.simulationTimeMs ?? 0,
        journalLines,
        lastEventTypes: [...new Set(lastEventTypes)].slice(0, 8),
      });
    }
  }
  return rows.sort((left, right) => left.gameId.localeCompare(right.gameId));
}

const root = appData();
const displays = windowsDisplays();
const config = root ? readJson(join(root, "games.json")) : null;
const displayConfig = root ? readJson(join(root, "display.json")) : null;
const games = root ? readJson(join(root, "games", ".grants.json")) : null;
const instances = root ? instanceRows(join(root, "game-data")) : [];

const lines = [];
lines.push("# Lull Game Runtime 稳定性报告（自动采集）");
lines.push("");
lines.push(`- 生成时间：${new Date().toISOString()}`);
lines.push(`- 平台：${process.platform} ${process.arch}`);
lines.push(`- 应用数据：${root ?? "（未找到 APPDATA）"}`);
lines.push("");
lines.push("## 显示器拓扑");
lines.push("");
if (displays.length === 0) {
  lines.push("> 未能通过 System.Windows.Forms 读取显示器；请手工填写。");
} else {
  lines.push("| 设备 | 主屏 | X | Y | 宽 | 高 |");
  lines.push("| --- | --- | --- | --- | --- | --- |");
  for (const display of displays) {
    lines.push(
      `| ${display.deviceName} | ${display.primary ? "是" : "否"} | ${display.x} | ${display.y} | ${display.width} | ${display.height} |`,
    );
  }
}
lines.push("");
lines.push("## Lull 显示配置");
lines.push("");
if (displayConfig?.monitors) {
  const monitorList = Array.isArray(displayConfig.monitors)
    ? displayConfig.monitors
    : Object.entries(displayConfig.monitors).map(([id, value]) => ({
        id,
        ...(value ?? {}),
      }));
  lines.push("| key | 启用 | 场景 | 模式 |");
  lines.push("| --- | --- | --- | --- |");
  for (const monitor of monitorList) {
    lines.push(
      `| ${monitor.id ?? monitor.name ?? "?"} | ${monitor.enabled ?? "?"} | ${monitor.scene ?? displayConfig.display?.scene ?? "?"} | ${displayConfig.display?.mode ?? "?"} |`,
    );
  }
} else {
  lines.push("> 未读取到 display.json。");
}
lines.push("");
lines.push("## 游戏偏好（games.json）");
lines.push("");
lines.push("```json");
lines.push(JSON.stringify(config ?? {}, null, 2));
lines.push("```");
lines.push("");
lines.push("## 已启用游戏（.grants.json）");
lines.push("");
lines.push("```json");
lines.push(JSON.stringify(games ?? {}, null, 2));
lines.push("```");
lines.push("");
lines.push("## 最近实例状态（metadata + journal）");
lines.push("");
if (instances.length === 0) {
  lines.push("> 没有 game-data 实例。");
} else {
  lines.push(
    "| game | instance | status | revision | epoch | journal 行 | 最近事件类型 |",
  );
  lines.push("| --- | --- | --- | --- | --- | --- | --- |");
  for (const row of instances) {
    lines.push(
      `| ${row.gameId} | ${row.instanceId.slice(0, 12)}… | ${row.status} | ${row.revision} | ${row.authorityEpoch} | ${row.journalLines} | ${row.lastEventTypes.join(", ") || "—"} |`,
    );
  }
}
lines.push("");
lines.push("## 运行时计数");
lines.push("");
lines.push(
  "在设置页「游戏」点击「复制诊断」获取 `game_runtime_diagnostics`（uptime、ticks、commits、events、lease 剩余、replicas/controllers）。把 JSON 粘贴到这里：",
);
lines.push("");
lines.push("```json");
lines.push("{ }");
lines.push("```");
lines.push("");
lines.push("## 手工验收（mirror / span）");
lines.push("");
lines.push("- [ ] 两块显示器都渲染当前游戏，revision 在 1s 内一致");
lines.push("- [ ] 任一显示器壁纸重建后，实例不停机、另一屏继续渲染");
lines.push("- [ ] mirror 模式两屏构图一致；span 模式跨屏画布连续");
lines.push("- [ ] 掉电/强杀 authority 后从最后一次成功提交恢复");
lines.push("- [ ] 2 小时运行后 contextLost = 0，堆增长在阈值内");
lines.push("");
lines.push("验收阈值与结论见 `docs/game-runtime-webview-stability.md`。");
lines.push("");

const report = lines.join("\n");
if (outPath) {
  writeFileSync(outPath, report, "utf8");
  console.log(`[stability] 报告已写入 ${outPath}`);
} else {
  console.log(report);
}
