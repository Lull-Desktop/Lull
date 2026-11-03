// biome-ignore-all lint/correctness/noUndeclaredDependencies: workspace package is resolved by the app build.
/**
 * 开发调试面板：智能随机（Smart Shuffle）API 的文档 + 在线调用。
 *
 * 面向开发者展示 Profile / Strategy / Engine 三层对应的公开接口、
 * 配置字段、固定约束与真实返回，避免只靠阅读 Rust 代码理解能力边界。
 */
"use client";

import {
  DEFAULT_SMART_SHUFFLE_CONFIG,
  type LullMediaClient,
  type SmartShuffleConfig,
  type SmartShuffleProfile,
  type SmartShuffleProfileSummary,
} from "@lull/media-sdk";
import { useCallback, useEffect, useId, useState } from "react";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";

const API_METHODS = [
  {
    sdk: "player.listShuffleProfiles()",
    method: "player.listShuffleProfiles",
    permission: "media.player.read",
    note: "内置在前，返回 active 标记。",
  },
  {
    sdk: "player.getShuffleProfile(profileId?)",
    method: "player.getShuffleProfile",
    permission: "media.player.read",
    note: "省略 profileId 时读取激活配置。",
  },
  {
    sdk: "player.saveShuffleProfile({ profileId?, name, config })",
    method: "player.saveShuffleProfile",
    permission: "media.player.control",
    note: "省略 profileId 时创建；内置配置不可修改。",
  },
  {
    sdk: "player.deleteShuffleProfile(profileId)",
    method: "player.deleteShuffleProfile",
    permission: "media.player.control",
    note: "只能删除用户配置；激活项回退均衡随机。",
  },
  {
    sdk: "player.activateShuffleProfile(profileId)",
    method: "player.activateShuffleProfile",
    permission: "media.player.control",
    note: "切换配置但不清空当前轮次。",
  },
  {
    sdk: "player.getSmartShuffleConfig()",
    method: "player.getSmartShuffleConfig",
    permission: "media.player.read",
    note: "兼容别名：返回激活配置的 config。",
  },
  {
    sdk: "player.setSmartShuffleConfig(config)",
    method: "player.setSmartShuffleConfig",
    permission: "media.player.control",
    note: "兼容别名：更新激活用户配置，或创建 user:custom。",
  },
] as const;

const CONFIG_FIELDS = [
  {
    path: "version",
    range: "必须为 1",
    fallback: "1",
    note: "配置版本；不支持时写入返回 argument.invalid。",
  },
  {
    path: "experience.randomness",
    range: "0–100",
    fallback: "60",
    note: "uniform 混合比例 alpha=(v/100)^2；100 在硬约束内均匀，0 偏向评分。",
  },
  {
    path: "experience.diversity",
    range: "0–100",
    fallback: "50",
    note: "曲风软惩罚强度；0 关闭同曲风惩罚。",
  },
  {
    path: "experience.repeatAvoidance",
    range: "0–100",
    fallback: "80",
    note: "最近 round(v/100*4) 首硬排除 + 软近期惩罚；80 → 3 首。",
  },
  {
    path: "separation.artist",
    range: "0–10",
    fallback: "3",
    note: "最近 N 首内同歌手软惩罚窗口；0 关闭。",
  },
  {
    path: "separation.album",
    range: "0–10",
    fallback: "2",
    note: "最近 N 首内同专辑软惩罚窗口；0 关闭。",
  },
  {
    path: "audioFeatures.*",
    range: "0–100",
    fallback: "30/30/30/50",
    note: "v1 预留字段，不参与选曲、不展示、不参与策略评分。",
  },
] as const;

const BUILTIN_PROFILES = [
  {
    id: "builtin:balanced",
    name: "均衡随机",
    values:
      "randomness 60 · diversity 50 · repeatAvoidance 80 · artist 3 · album 2",
  },
  {
    id: "builtin:random",
    name: "高度随机",
    values:
      "randomness 90 · diversity 25 · repeatAvoidance 50 · artist 1 · album 1",
  },
  {
    id: "builtin:diverse",
    name: "多样性优先",
    values:
      "randomness 40 · diversity 100 · repeatAvoidance 90 · artist 6 · album 4",
  },
] as const;

const FIXED_RULES = [
  "一轮内不重复；播完自动开新一轮，当前曲进入新袋，由近期硬窗口避免立刻重播。",
  "候选优先 setAdvanceList 同步的当前页签，未设置或为空时回退 player_queue。",
  "shuffle 下 previous 走引擎历史栈；无历史时回退加权下一首。",
  "切换 Profile 不清空轮次；离开 shuffle 模式才 reset 轮次与历史。",
  "内置 Profile 只读；用户 Profile 最多 50 个，名称 1–40 字符、大小写不敏感唯一。",
] as const;

const QUICKSTART = `const profiles = await client.player.listShuffleProfiles();
const active = await client.player.getShuffleProfile();

const saved = await client.player.saveShuffleProfile({
  name: "夜航",
  config: active.config,
});
const activated = await client.player.activateShuffleProfile(saved.id);`;

const SAMPLE_SAVE_REQUEST = JSON.stringify(
  { name: "夜航", config: DEFAULT_SMART_SHUFFLE_CONFIG },
  null,
  2,
);

const SAMPLE_PROFILE = JSON.stringify(
  {
    id: "shuffle_profile_0192f0c4-7f00-7a2e-9c2a-1d2e3f4a5b6c",
    name: "夜航",
    builtin: false,
    config: DEFAULT_SMART_SHUFFLE_CONFIG,
  },
  null,
  2,
);

const SAMPLE_LIST = JSON.stringify(
  [
    { id: "builtin:balanced", name: "均衡随机", builtin: true, active: true },
    { id: "builtin:random", name: "高度随机", builtin: true, active: false },
    {
      id: "shuffle_profile_0192f0c4-7f00-7a2e-9c2a-1d2e3f4a5b6c",
      name: "夜航",
      builtin: false,
      active: false,
    },
  ],
  null,
  2,
);

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function json(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function parseConfig(text: string): SmartShuffleConfig {
  const parsed: unknown = JSON.parse(text);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("config 必须是 JSON 对象");
  }
  return parsed as SmartShuffleConfig;
}

function CodeBlock({ children }: { children: string }) {
  return (
    <pre className="max-h-72 overflow-auto rounded-md border border-border/60 bg-muted/40 p-3 font-mono text-xs leading-5 whitespace-pre-wrap break-all">
      {children}
    </pre>
  );
}

type RunResult = {
  label: string;
  data: unknown;
};

export function SmartShuffleApiPanel({ client }: { client: LullMediaClient }) {
  const nameFieldId = useId();
  const configFieldId = useId();
  const [profiles, setProfiles] = useState<SmartShuffleProfileSummary[]>([]);
  const [active, setActive] = useState<SmartShuffleProfile | null>(null);
  const [selected, setSelected] = useState<SmartShuffleProfile | null>(null);
  const [selectedId, setSelectedId] = useState("");
  const [name, setName] = useState("API 试验配置");
  const [configText, setConfigText] = useState(() =>
    JSON.stringify(DEFAULT_SMART_SHUFFLE_CONFIG, null, 2),
  );
  const [deleteArmed, setDeleteArmed] = useState(false);
  const [busy, setBusy] = useState("");
  const [error, setError] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);

  const reloadProfiles = useCallback(async (): Promise<{
    profiles: SmartShuffleProfileSummary[];
    active: SmartShuffleProfile;
  }> => {
    const [list, current] = await Promise.all([
      client.player.listShuffleProfiles(),
      client.player.getShuffleProfile(),
    ]);
    setProfiles(list);
    setActive(current);
    setSelected(current);
    setSelectedId(current.id);
    setConfigText(json(current.config));
    return { profiles: list, active: current };
  }, [client]);

  useEffect(() => {
    let alive = true;
    void reloadProfiles().catch((reason: unknown) => {
      if (alive) setError(errorText(reason));
    });
    return () => {
      alive = false;
    };
  }, [reloadProfiles]);

  const run = useCallback(
    async (label: string, action: () => Promise<unknown>): Promise<unknown> => {
      setBusy(label);
      setError("");
      try {
        const data = await action();
        setResult({ label, data });
        return data;
      } catch (reason) {
        const message = errorText(reason);
        setError(message);
        setResult({ label, data: { error: message } });
        return null;
      } finally {
        setBusy("");
      }
    },
    [],
  );

  const loadProfiles = (): void => {
    void run("player.listShuffleProfiles + getShuffleProfile", async () => {
      const data = await reloadProfiles();
      return { profiles: data.profiles, active: data.active };
    });
  };

  const loadSelected = (): void => {
    if (!selectedId) return;
    void run(`player.getShuffleProfile(${selectedId})`, async () => {
      const profile = await client.player.getShuffleProfile(selectedId);
      setSelected(profile);
      setConfigText(json(profile.config));
      return profile;
    });
  };

  const activateSelected = (): void => {
    if (!selectedId) return;
    void run(`player.activateShuffleProfile(${selectedId})`, async () => {
      const profile = await client.player.activateShuffleProfile(selectedId);
      setActive(profile);
      setSelected(profile);
      setConfigText(json(profile.config));
      setProfiles((previous) =>
        previous.map((item) => ({
          ...item,
          active: item.id === profile.id,
        })),
      );
      return profile;
    });
  };

  const deleteSelected = (): void => {
    if (!selectedId || !selected || selected.builtin) return;
    if (!deleteArmed) {
      setDeleteArmed(true);
      return;
    }
    setDeleteArmed(false);
    void run(`player.deleteShuffleProfile(${selectedId})`, async () => {
      const removed = await client.player.deleteShuffleProfile(selectedId);
      const data = await reloadProfiles();
      return { removed, active: data.active };
    });
  };

  const saveAs = (): void => {
    if (!name.trim()) {
      setError("请输入配置名称");
      return;
    }
    void run("player.saveShuffleProfile + activateShuffleProfile", async () => {
      const config = parseConfig(configText);
      const saved = await client.player.saveShuffleProfile({
        name: name.trim(),
        config,
      });
      const activated = await client.player.activateShuffleProfile(saved.id);
      const data = await reloadProfiles();
      return { saved, activated, profiles: data.profiles };
    });
  };

  const saveSelected = (): void => {
    if (!selected || selected.builtin) return;
    void run(`player.saveShuffleProfile(${selected.id})`, async () => {
      const config = parseConfig(configText);
      const saved = await client.player.saveShuffleProfile({
        profileId: selected.id,
        name: selected.name,
        config,
      });
      setSelected(saved);
      setConfigText(json(saved.config));
      if (active?.id === saved.id) setActive(saved);
      return saved;
    });
  };

  const fillSelectedConfig = (): void => {
    if (!selected) return;
    setConfigText(json(selected.config));
  };

  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>
          <CardTitle>智能随机 API 能力</CardTitle>
          <CardDescription>
            随机播放由 Rust Media Service 的 Profile / Strategy / Engine
            三层实现。
            这里列出公开接口、配置字段、固定约束与真实返回，可直接在下方调用。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-5 lg:grid-cols-2">
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-medium">接口清单</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border/60 text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">
                      SDK / media_call
                    </th>
                    <th className="py-1.5 pr-3 font-medium">权限</th>
                    <th className="py-1.5 font-medium">说明</th>
                  </tr>
                </thead>
                <tbody>
                  {API_METHODS.map((item) => (
                    <tr key={item.method} className="border-b border-border/40">
                      <td className="py-2 pr-3 align-top">
                        <code className="font-mono text-[11px]">
                          {item.sdk}
                        </code>
                        <div className="mt-0.5 font-mono text-[10px] text-muted-foreground">
                          {item.method}
                        </div>
                      </td>
                      <td className="py-2 pr-3 align-top text-[10px] text-muted-foreground">
                        {item.permission}
                      </td>
                      <td className="py-2 align-top text-[11px] text-muted-foreground">
                        {item.note}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
          <div className="min-w-0">
            <h3 className="mb-2 text-sm font-medium">快速调用</h3>
            <CodeBlock>{QUICKSTART}</CodeBlock>
            <p className="mt-2 text-xs text-muted-foreground">
              公开层只有 Profile；Strategy 的评分/概率与 Engine
              的轮次/历史不暴露。
            </p>
          </div>
        </CardContent>
      </Card>

      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">配置参数</CardTitle>
            <CardDescription>
              写入时会 clamp 到范围；读取到损坏/不支持版本时回退默认值。
            </CardDescription>
          </CardHeader>
          <CardContent className="overflow-x-auto">
            <table className="w-full text-left text-xs">
              <thead className="border-b border-border/60 text-muted-foreground">
                <tr>
                  <th className="py-1.5 pr-3 font-medium">字段</th>
                  <th className="py-1.5 pr-3 font-medium">范围</th>
                  <th className="py-1.5 pr-3 font-medium">默认</th>
                  <th className="py-1.5 font-medium">含义</th>
                </tr>
              </thead>
              <tbody>
                {CONFIG_FIELDS.map((item) => (
                  <tr key={item.path} className="border-b border-border/40">
                    <td className="py-2 pr-3 align-top font-mono text-[11px]">
                      {item.path}
                    </td>
                    <td className="py-2 pr-3 align-top text-[11px] text-muted-foreground">
                      {item.range}
                    </td>
                    <td className="py-2 pr-3 align-top font-mono text-[11px]">
                      {item.fallback}
                    </td>
                    <td className="py-2 align-top text-[11px] text-muted-foreground">
                      {item.note}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </CardContent>
        </Card>

        <Card>
          <CardHeader className="pb-3">
            <CardTitle className="text-base">内置配置与固定约束</CardTitle>
            <CardDescription>
              内置参数按 randomness / diversity / repeatAvoidance · artist /
              album 排列。
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-4">
            <div className="overflow-x-auto">
              <table className="w-full text-left text-xs">
                <thead className="border-b border-border/60 text-muted-foreground">
                  <tr>
                    <th className="py-1.5 pr-3 font-medium">ID / 名称</th>
                    <th className="py-1.5 font-medium">参数</th>
                  </tr>
                </thead>
                <tbody>
                  {BUILTIN_PROFILES.map((item) => (
                    <tr key={item.id} className="border-b border-border/40">
                      <td className="py-2 pr-3 align-top">
                        <div className="font-medium">{item.name}</div>
                        <code className="font-mono text-[10px] text-muted-foreground">
                          {item.id}
                        </code>
                      </td>
                      <td className="py-2 align-top text-[11px] text-muted-foreground">
                        {item.values}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <ul className="list-disc space-y-1 pl-4 text-[11px] text-muted-foreground">
              {FIXED_RULES.map((rule) => (
                <li key={rule}>{rule}</li>
              ))}
            </ul>
          </CardContent>
        </Card>
      </div>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">在线能力测试</CardTitle>
          <CardDescription>
            直接调用窗口共享的 media
            client；每次调用都会显示真实返回，便于核对字段与错误码。
          </CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <div className="flex flex-wrap items-center gap-2">
            <select
              value={selectedId}
              onChange={(event) => {
                setSelectedId(event.target.value);
                setSelected(null);
                setDeleteArmed(false);
              }}
              aria-label="随机播放配置"
              className="max-w-[22rem] rounded-md border border-border bg-background px-2 py-1.5 text-sm"
            >
              {profiles.length === 0 ? <option value="">加载中…</option> : null}
              {profiles.map((item) => (
                <option key={item.id} value={item.id}>
                  {item.name}
                  {item.builtin ? "（内置）" : ""}
                  {item.active ? " · 激活" : ""}
                </option>
              ))}
            </select>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={loadProfiles}
              disabled={busy !== ""}
            >
              读取列表
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={loadSelected}
              disabled={busy !== "" || !selectedId}
            >
              读取选中
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={activateSelected}
              disabled={busy !== "" || !selectedId}
            >
              激活选中
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={fillSelectedConfig}
              disabled={!selected}
            >
              填入选中配置
            </Button>
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={deleteSelected}
              disabled={
                busy !== "" || !selectedId || !selected || selected.builtin
              }
            >
              {deleteArmed ? "确认删除" : "删除选中"}
            </Button>
            {busy ? (
              <span className="text-xs text-muted-foreground">
                执行中：{busy}
              </span>
            ) : null}
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div className="space-y-2">
              <label
                className="block text-xs font-medium"
                htmlFor={nameFieldId}
              >
                另存名称
              </label>
              <input
                id={nameFieldId}
                value={name}
                onChange={(event) => setName(event.target.value)}
                maxLength={40}
                className="w-full rounded-md border border-border bg-background px-2 py-1.5 text-sm"
                placeholder="配置名称"
              />
              <label
                className="block text-xs font-medium"
                htmlFor={configFieldId}
              >
                配置 JSON
              </label>
              <textarea
                id={configFieldId}
                value={configText}
                onChange={(event) => setConfigText(event.target.value)}
                rows={14}
                spellCheck={false}
                className="w-full rounded-md border border-border bg-background p-2 font-mono text-xs leading-5"
              />
              <div className="flex flex-wrap gap-2">
                <Button
                  type="button"
                  size="sm"
                  onClick={saveAs}
                  disabled={busy !== ""}
                >
                  另存为新配置
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={saveSelected}
                  disabled={busy !== "" || !selected || selected.builtin}
                >
                  保存到选中
                </Button>
              </div>
            </div>

            <div className="min-w-0 space-y-2">
              <div className="rounded-md border border-border/60 px-3 py-2 text-xs">
                {active ? (
                  <>
                    <div>
                      当前激活：<strong>{active.name}</strong>
                    </div>
                    <code className="font-mono text-[10px] text-muted-foreground">
                      {active.id}
                    </code>
                  </>
                ) : (
                  <span className="text-muted-foreground">
                    尚未读取激活配置
                  </span>
                )}
                {selected ? (
                  <div className="mt-1 text-muted-foreground">
                    选中：{selected.name}
                    {selected.builtin ? "（内置，只读）" : "（用户配置）"}
                  </div>
                ) : null}
              </div>
              {error ? (
                <div className="rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2 text-xs text-destructive">
                  错误：{error}
                </div>
              ) : null}
              <div>
                <div className="mb-1 text-xs font-medium">
                  最近返回
                  {result ? ` · ${result.label}` : ""}
                </div>
                <CodeBlock>{result ? json(result.data) : "尚未调用"}</CodeBlock>
              </div>
            </div>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="pb-3">
          <CardTitle className="text-base">输入 / 返回示例</CardTitle>
          <CardDescription>
            真实响应中的 Profile id 由后端生成；内置配置的 builtin 为 true
            且不可写。
          </CardDescription>
        </CardHeader>
        <CardContent className="grid gap-4 lg:grid-cols-2">
          <div className="min-w-0">
            <h4 className="mb-1 text-xs font-medium">
              saveShuffleProfile 请求
            </h4>
            <CodeBlock>{SAMPLE_SAVE_REQUEST}</CodeBlock>
          </div>
          <div className="min-w-0">
            <h4 className="mb-1 text-xs font-medium">
              saveShuffleProfile / getShuffleProfile 返回
            </h4>
            <CodeBlock>{SAMPLE_PROFILE}</CodeBlock>
          </div>
          <div className="min-w-0">
            <h4 className="mb-1 text-xs font-medium">
              listShuffleProfiles 返回
            </h4>
            <CodeBlock>{SAMPLE_LIST}</CodeBlock>
          </div>
          <div className="min-w-0">
            <h4 className="mb-1 text-xs font-medium">
              deleteShuffleProfile 返回
            </h4>
            <CodeBlock>{json({ removed: true })}</CodeBlock>
          </div>
          <div className="min-w-0">
            <h4 className="mb-1 text-xs font-medium">错误示例</h4>
            <CodeBlock>
              {json({
                error: {
                  code: "shuffle.profile.builtin",
                  message: "内置智能随机配置不可修改",
                },
              })}
            </CodeBlock>
          </div>
        </CardContent>
      </Card>
    </div>
  );
}
