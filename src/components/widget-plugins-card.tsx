/**
 * 设置页的「自定义插件」卡片：列出已安装包、授权状态与打开/撤销操作。
 *
 * 插件包放在 `%APPDATA%\app.lull.desktop\widgets\<id>\`；这里不提供安装器，
 * 只负责启用（授予清单声明的能力）与撤销（清状态并关窗）。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { RefreshCw } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Switch } from "@/components/ui/switch";

type PluginWindow = {
  width: number;
  height: number;
  minWidth: number;
  minHeight: number;
  resizable: boolean;
  transparent: boolean;
  chrome?: "host" | "custom";
};

export type PluginPackage = {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;
  license?: string;
  status: "ready" | "invalid";
  error?: string;
  requested: string[];
  granted: string[];
  enabled: boolean;
  window: PluginWindow;
  entryUrl: string;
  hostApi: number;
};

const CAPABILITY_LABELS: Record<string, string> = {
  "widget.ui": "界面",
  "widget.theme": "主题",
  "widget.state": "状态",
  "widget.audio": "音频",
  "widget.media": "媒体",
  "widget.network": "网络",
};

function capabilityLabel(capability: string): string {
  return CAPABILITY_LABELS[capability] ?? capability;
}

export function WidgetPluginsCard() {
  const [packages, setPackages] = useState<PluginPackage[] | null>(null);
  const [message, setMessage] = useState("");

  const refresh = useCallback((): void => {
    invoke<PluginPackage[]>("widget_packages")
      .then((list) => {
        setPackages(Array.isArray(list) ? list : []);
        setMessage("");
      })
      .catch((error: unknown) => {
        setPackages([]);
        setMessage(`读取插件列表失败：${String(error)}`);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const setEnabled = useCallback(
    (id: string, enabled: boolean): void => {
      setPackages((previous) =>
        previous
          ? previous.map((item) =>
              item.id === id ? { ...item, enabled } : item,
            )
          : previous,
      );
      invoke("widget_package_set_enabled", { id, enabled })
        .then(refresh)
        .catch((error: unknown) => {
          setMessage(`更新授权失败：${String(error)}`);
          refresh();
        });
    },
    [refresh],
  );

  const openPackage = useCallback((id: string): void => {
    invoke("widget_package_open", { id }).catch((error: unknown) => {
      setMessage(`打开插件失败：${String(error)}`);
    });
  }, []);

  const revoke = useCallback(
    (id: string): void => {
      invoke("widget_package_revoke", { id })
        .then(refresh)
        .catch((error: unknown) => {
          setMessage(`撤销失败：${String(error)}`);
        });
    },
    [refresh],
  );

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <RefreshCw className="h-5 w-5 text-bamboo" />
          自定义插件
        </CardTitle>
        <CardDescription>
          放在 %APPDATA%\app.lull.desktop\widgets\&lt;id&gt;\ 的第三方 Widget
          包；启用即授予清单声明的能力，撤销会清空插件状态。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {packages === null
              ? "读取中…"
              : `已发现 ${packages.length} 个插件包`}
          </p>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={refresh}
            className="gap-1.5"
          >
            <RefreshCw className="h-3.5 w-3.5" />
            刷新
          </Button>
        </div>

        {packages?.length === 0 && (
          <p className="rounded-lg border border-dashed border-border/70 p-4 text-xs text-muted-foreground">
            还没有安装插件。把包含 widget.json 与 index.html
            的目录放到上述路径后点「刷新」。
          </p>
        )}

        {packages?.map((item) => (
          <div
            key={item.id}
            className="space-y-2 rounded-lg border border-border/60 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="truncate text-sm text-ink-soft">
                    {item.name}
                  </span>
                  <span className="text-[10px] text-ink-faint">
                    {item.version} · {item.id}
                  </span>
                  {item.status === "invalid" && (
                    <Badge variant="destructive">清单无效</Badge>
                  )}
                  {item.window.chrome === "custom" && (
                    <Badge variant="outline">自绘 chrome</Badge>
                  )}
                </div>
                {item.description && (
                  <p className="text-xs text-muted-foreground">
                    {item.description}
                  </p>
                )}
                {item.error && (
                  <p className="text-xs text-destructive">{item.error}</p>
                )}
                <div className="flex flex-wrap gap-1 pt-1">
                  {item.requested.map((capability) => (
                    <Badge key={capability} variant="secondary">
                      {capabilityLabel(capability)}
                    </Badge>
                  ))}
                  {item.requested.length === 0 && (
                    <span className="text-[11px] text-ink-faint">
                      无能力声明
                    </span>
                  )}
                </div>
              </div>
              <div className="flex shrink-0 items-center gap-2">
                <Switch
                  aria-label={`${item.name}启用`}
                  checked={item.enabled}
                  disabled={item.status !== "ready"}
                  onCheckedChange={(enabled) => setEnabled(item.id, enabled)}
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  disabled={!item.enabled || item.status !== "ready"}
                  onClick={() => openPackage(item.id)}
                >
                  打开
                </Button>
                <Button
                  type="button"
                  size="sm"
                  variant="ghost"
                  onClick={() => revoke(item.id)}
                >
                  撤销
                </Button>
              </div>
            </div>
            {item.granted.length > 0 && (
              <p className="text-[11px] text-ink-faint">
                已授予：{item.granted.map(capabilityLabel).join("、")}
              </p>
            )}
          </div>
        ))}

        {message && <p className="text-xs text-destructive">{message}</p>}
      </CardContent>
    </Card>
  );
}
