/**
 * 曲库抽屉页脚的音乐导入入口：系统目录选择器 + 单曲文件选择器。
 *
 * 只负责展示与点击回调；打开选择器、导入、刷新由 `LiquidPlayer` 负责，
 * 便于在不加载 widget 桥的情况下单测按钮启用/禁用与事件。
 */
"use client";

import { FileMusic, FolderPlus } from "lucide-react";
import type { ReactElement } from "react";
import styles from "./liquid-player.module.css";

export type LibraryImportActionsProps = {
  onAddFolder: () => void;
  onAddSingles: () => void;
  /** 系统选择器/导入进行中时禁用，避免重复弹窗。 */
  disabled?: boolean;
};

export function LibraryImportActions({
  onAddFolder,
  onAddSingles,
  disabled = false,
}: LibraryImportActionsProps): ReactElement {
  return (
    <div className={styles.footActions}>
      <button
        type="button"
        className={styles.footAction}
        onClick={onAddFolder}
        disabled={disabled}
      >
        <FolderPlus aria-hidden="true" />
        <span>导入目录</span>
      </button>
      <button
        type="button"
        className={styles.footAction}
        onClick={onAddSingles}
        disabled={disabled}
      >
        <FileMusic aria-hidden="true" />
        <span>导入单曲</span>
      </button>
    </div>
  );
}
