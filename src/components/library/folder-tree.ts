/**
 * 资料库目录的层级派生。
 *
 * 目录模型（`MusicFolderView`）没有 parentId，层级只能从 `rootPath` 的包含关系
 * 推断：某个目录的路径落在另一个目录之下时，它就显示为子目录。路径缺失的目录
 * 一律当根目录处理，不参与父子判定。
 *
 * 这里只吃结构性子集，不直接依赖 SDK，避免把 UI 组件和包依赖绑在一起。
 */
export type FolderSource = {
  id: string;
  name: string;
  rootPath?: string;
};

export type FolderRow<T extends FolderSource = FolderSource> = {
  folder: T;
  /** 0 为根目录；每多一层父目录 +1。 */
  depth: number;
};

/** 层数上限：异常路径（重复斜杠、超长嵌套）不应该把缩进拉爆。 */
const MAX_DEPTH = 8;

/** 统一分隔符与大小写，让 `D:\Music` 与 `d:/music/` 能互相比较。 */
function comparablePath(path?: string): string {
  if (!path) return "";
  return path
    .replace(/[\\/]+/g, "\\")
    .replace(/\\+$/, "")
    .toLowerCase();
}

/**
 * 按路径排序并算出每一行的缩进层级。
 *
 * 排序用路径字符串本身：父目录一定是子目录的前缀，因此正序排列天然就是
 * 「父在子前」的展开顺序，不需要再建树。
 */
export function folderRows<T extends FolderSource>(
  folders: T[],
): FolderRow<T>[] {
  const entries = folders.map((folder) => ({
    folder,
    path: comparablePath(folder.rootPath),
  }));
  const ordered = [...entries].sort((left, right) => {
    const a = left.path || left.folder.name.toLowerCase();
    const b = right.path || right.folder.name.toLowerCase();
    const byPath = a.localeCompare(b);
    return byPath === 0
      ? left.folder.id.localeCompare(right.folder.id)
      : byPath;
  });
  return ordered.map((entry) => {
    let depth = 0;
    if (entry.path) {
      const self = `${entry.path}\\`;
      for (const other of entries) {
        if (other === entry || !other.path) continue;
        if (self.startsWith(`${other.path}\\`)) depth += 1;
      }
    }
    return { folder: entry.folder, depth: Math.min(depth, MAX_DEPTH) };
  });
}
