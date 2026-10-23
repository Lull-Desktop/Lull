/**
 * 设置页的「内容包」卡片：列出用户安装的场景包，支持拖拽安装、卸载与打开目录。
 *
 * 安装判定全在 Rust 侧：清单校验 + 整包摘要复核 + 路径安全，通过后才落盘。
 * 这里只负责把路径递过去、把结果显示出来，不做任何信任判断。
 */
"use client";

import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { FolderOpen, Package, RefreshCw, Trash2, Upload } from "lucide-react";
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
import {
  listUserContentPackages,
  type UserContentPackage,
} from "@/content/user-content";
import { isDesktopWindow } from "@/core/window/controls";

const REMOVE_CONFIRM_MS = 5000;

function statusBadge(pkg: UserContentPackage) {
  if (pkg.status === "tampered") {
    return <Badge variant="destructive">摘要不符</Badge>;
  }
  if (pkg.status === "invalid") {
    return <Badge variant="destructive">清单无效</Badge>;
  }
  return pkg.verified ? (
    <Badge variant="secondary">已校验</Badge>
  ) : (
    <Badge variant="outline">未校验</Badge>
  );
}

export function ContentPackagesCard() {
  const [packages, setPackages] = useState<UserContentPackage[] | null>(null);
  const [message, setMessage] = useState("");
  const [busy, setBusy] = useState(false);
  const [dragging, setDragging] = useState(false);
  const [pendingRemove, setPendingRemove] = useState<string | null>(null);

  const refresh = useCallback((): void => {
    listUserContentPackages()
      .then((list) => {
        setPackages(list);
      })
      .catch((error: unknown) => {
        setPackages([]);
        setMessage(`读取内容包失败：${String(error)}`);
      });
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // 二次确认：点第一次进入待删除，5 秒内再点才真删。
  useEffect(() => {
    if (!pendingRemove) return;
    const timer = window.setTimeout(
      () => setPendingRemove(null),
      REMOVE_CONFIRM_MS,
    );
    return () => window.clearTimeout(timer);
  }, [pendingRemove]);

  const installPaths = useCallback(
    async (paths: readonly string[]): Promise<void> => {
      if (paths.length === 0) return;
      setBusy(true);
      const lines: string[] = [];
      for (const path of paths) {
        try {
          const installed = await invoke<UserContentPackage>(
            "content_package_install",
            { path },
          );
          lines.push(`已安装 ${installed.name} ${installed.version}`);
        } catch (error) {
          lines.push(
            `安装失败：${error instanceof Error ? error.message : String(error)}`,
          );
        }
      }
      setMessage(lines.join("；"));
      setBusy(false);
      refresh();
    },
    [refresh],
  );

  // 拖拽安装：Tauri 把拖入窗口的文件系统路径交给前端。
  useEffect(() => {
    if (!isDesktopWindow()) return;
    let stop: (() => void) | null = null;
    let disposed = false;
    void getCurrentWindow()
      .onDragDropEvent((event) => {
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
          return;
        }
        if (event.payload.type === "leave") {
          setDragging(false);
          return;
        }
        setDragging(false);
        if (event.payload.type !== "drop") return;
        const paths = event.payload.paths ?? [];
        if (paths.length === 0) {
          setMessage("没有拿到拖入的文件路径：请改用「选择 zip」安装。");
          return;
        }
        void installPaths(paths);
      })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch((error: unknown) => {
        // 事件通道不可用（远程会话 / 被别的拖拽处理器接管）时给出去路。
        setMessage(
          `拖拽通道不可用（${String(error)}），请用「选择 zip」安装。`,
        );
      });
    return () => {
      disposed = true;
      stop?.();
    };
  }, [installPaths]);

  const pickAndInstall = useCallback(
    (folder: boolean): void => {
      setBusy(true);
      invoke<UserContentPackage | null>("content_package_pick_and_install", {
        folder,
      })
        .then((installed) => {
          setMessage(
            installed
              ? `已安装 ${installed.name} ${installed.version}`
              : "已取消选择",
          );
          refresh();
        })
        .catch((error: unknown) => {
          setMessage(`安装失败：${String(error)}`);
        })
        .finally(() => {
          setBusy(false);
        });
    },
    [refresh],
  );

  const openDir = useCallback((): void => {
    invoke<string>("content_open_dir")
      .then((path) => setMessage(`内容目录：${path}`))
      .catch((error: unknown) => setMessage(`打开目录失败：${String(error)}`));
  }, []);

  const remove = useCallback(
    (id: string): void => {
      if (pendingRemove !== id) {
        setPendingRemove(id);
        return;
      }
      setPendingRemove(null);
      invoke("content_package_remove", { id })
        .then(() => {
          setMessage(`已卸载 ${id}`);
          refresh();
        })
        .catch((error: unknown) => setMessage(`卸载失败：${String(error)}`));
    },
    [pendingRemove, refresh],
  );

  return (
    <Card className="w-full">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Package className="h-5 w-5 text-bamboo" />
          内容包
        </CardTitle>
        <CardDescription>
          壁纸场景的静态内容包：结构与官方内容目录一致（catalog.json +
          scenes/&lt;名称&gt;/）。 把 .zip
          或文件夹拖到本窗口即可安装，安装时会复核清单与整包摘要。
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {busy
              ? "正在安装…"
              : packages === null
                ? "读取中…"
                : `已安装 ${packages.length} 个内容包`}
          </p>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              size="sm"
              onClick={() => pickAndInstall(false)}
              disabled={busy}
              className="gap-1.5"
            >
              <Upload className="h-3.5 w-3.5" />
              选择 zip
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              onClick={openDir}
              className="gap-1.5"
            >
              <FolderOpen className="h-3.5 w-3.5" />
              内容目录
            </Button>
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
        </div>

        <div
          data-testid="content-drop-zone"
          className={`rounded-lg border border-dashed p-4 text-xs transition-colors ${
            dragging
              ? "border-bamboo bg-bamboo/10 text-ink-soft"
              : "border-border/70 text-muted-foreground"
          }`}
        >
          {dragging
            ? "松开即可安装"
            : "把 .zip 或内容包文件夹拖到这里；拖不动就点「选择 zip」，或在「内容目录」里放好后点「刷新」"}
        </div>

        {packages?.length === 0 && (
          <p className="text-xs text-muted-foreground">
            还没有安装内容包。内容包必须是单场景目录：根目录含
            catalog.json，entry 指向 scenes/&lt;名称&gt;/ 下的 HTML。
          </p>
        )}

        {packages?.map((pkg) => (
          <div
            key={pkg.id}
            className="space-y-2 rounded-lg border border-border/60 p-3"
          >
            <div className="flex items-start justify-between gap-3">
              <div className="min-w-0 space-y-1">
                <div className="flex flex-wrap items-baseline gap-2">
                  <span className="truncate text-sm text-ink-soft">
                    {pkg.name}
                  </span>
                  <span className="text-[10px] text-ink-faint">
                    {pkg.version} · {pkg.id}
                  </span>
                  {statusBadge(pkg)}
                </div>
                {pkg.description && (
                  <p className="text-xs text-muted-foreground">
                    {pkg.description}
                  </p>
                )}
                {pkg.error && (
                  <p className="text-xs text-destructive">{pkg.error}</p>
                )}
                {pkg.author && (
                  <p className="text-[11px] text-ink-faint">
                    作者 {pkg.author}
                    {pkg.license ? ` · ${pkg.license}` : ""}
                  </p>
                )}
              </div>
              <Button
                type="button"
                size="sm"
                variant={pendingRemove === pkg.id ? "destructive" : "ghost"}
                onClick={() => remove(pkg.id)}
                className="gap-1.5"
              >
                <Trash2 className="h-3.5 w-3.5" />
                {pendingRemove === pkg.id ? "确认卸载" : "卸载"}
              </Button>
            </div>
          </div>
        ))}

        {message && (
          <p className="text-xs text-muted-foreground break-all">{message}</p>
        )}
      </CardContent>
    </Card>
  );
}
