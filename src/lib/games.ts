/**
 * Game Runtime 的宿主侧 DTO：与 Rust `src-tauri/src/game/protocol.rs` 一一对应。
 *
 * 命令参数与返回值全部 camelCase（Tauri 负责 snake_case 转换）；游戏包与 SDK
 * 不复用这里的类型，两侧靠契约测试钉住字段，避免宿主实现泄漏进游戏包。
 */

/** 游戏实例的运行状态；`interrupted` 来自存档恢复（metadata.status）。 */
export type GameStatus =
  | "starting"
  | "ready"
  | "running"
  | "hidden"
  | "suspended"
  | "background"
  | "stopping"
  | "stopped"
  | "failed"
  | "interrupted";

/** 兼容命名：实例状态。 */
export type GameInstanceStatus = GameStatus;

/** 游戏包本身的状态（与实例是否运行无关）。 */
export type GamePackageStatus = "ready" | "invalid" | "disabled";

/** 宿主错误体；`code` 是稳定契约，`message` 可直接展示。 */
export type GameErrorBody = {
  code: string;
  message: string;
  detail?: string;
};

/** 单个游戏实例的宿主视图。 */
export type GameInstanceView = {
  gameId: string;
  instanceId: string;
  authorityEpoch: number;
  revision: number;
  simulationTimeMs: number;
  status: GameStatus;
  lastError?: GameErrorBody | null;
  replicas: number;
  controllers: number;
  updatedAt: number;
};

/** 控制器窗口的载体：包内页面或外部 Widget。 */
export type GameControllerKind = "package" | "widget";

/** 游戏声明的控制器窗口（含安装/启用与运行态）。 */
export type GameControllerView = {
  /** 清单里的槽位 id；旧单数声明归一化为 `default`。 */
  id: string;
  kind: GameControllerKind;
  /** 清单/Widget 提供的展示名；缺省时回退到 id。 */
  label?: string | null;
  widgetId?: string | null;
  entry?: string | null;
  installed: boolean;
  enabled: boolean;
  autoOpen: boolean;
  /** 控制器窗口当前是否存在。 */
  windowOpen: boolean;
  /** 控制器是否已连接。 */
  connected: boolean;
};

/** 已安装游戏的宿主视图（设置页与扩展中心共用）。 */
export type GameView = {
  id: string;
  name: string;
  version: string;
  description?: string | null;
  author?: string | null;
  /** Rust 侧为 `Option<String>`：旧包可能没有 license。 */
  license?: string | null;
  status: GamePackageStatus;
  error?: string | null;
  enabled: boolean;
  granted: string[];
  capabilities: string[];
  /** 包内 `entry.replica` 的 `lullgame://` URL；没有自带渲染入口时缺席。 */
  entryReplicaUrl?: string | null;
  stateSchemaVersion: number;
  /** 清单声明的控制器窗口；未声明时为空数组。 */
  controllers: GameControllerView[];
  instance?: GameInstanceView | null;
};

/** 壁纸直接挂载游戏包自带渲染入口时的解析结果。 */
export type GameReplicaEntry = {
  gameId: string;
  name: string;
  version: string;
  /** `entry.replica` 的 `lullgame://` URL；旧包没有自带渲染入口时为 null。 */
  entryUrl: string | null;
  enabled: boolean;
};

/** 宿主硬上限的公开视图；manifest 只能收紧，不能放宽。 */
export type GameLimits = {
  maxStateBytes: number;
  maxEventBytes: number;
  maxEventsPerCommit: number;
  maxRenderStateBytes: number;
  maxReplicas: number;
  tickMs: number;
};

/** 物理像素矩形，语义与 SceneFrame 一致。 */
export type GameRenderRect = {
  x: number;
  y: number;
  w: number;
  h: number;
};

/** 单屏渲染上下文：几何直接来自 SceneFrame，不另算一套坐标。 */
export type GameRenderContext = {
  protocol: 1;
  displayId: string;
  mode: "mirror" | "span";
  canvas: GameRenderRect;
  view: GameRenderRect;
  viewport: { width: number; height: number; dpr: number };
};

export type GameRole = "authority" | "replica" | "controller";

/** `game_connect` 返回的参与者上下文；实例未运行时整个 context 为 null。 */
export type GameContext = {
  protocol: 1;
  hostApi: 1;
  role: GameRole;
  gameId: string;
  instanceId?: string | null;
  authorityId?: string | null;
  authorityEpoch: number;
  revision: number;
  simulationTimeMs: number;
  render?: GameRenderContext | null;
  /** Controller 角色才有：宿主声明的控制器槽位 id。 */
  controllerId?: string | null;
  limits: GameLimits;
  locale: string;
};

/** 完整权威快照；`state` 对宿主是不透明 JSON。 */
export type GameSnapshot<T = unknown> = {
  protocol: 1;
  gameId: string;
  instanceId: string;
  revision: number;
  authorityEpoch: number;
  simulationTimeMs: number;
  state: T;
};

/** 低频增量事件；`eventId` 由宿主生成。 */
export type GameEvent<T = unknown> = {
  protocol: 1;
  gameId: string;
  instanceId: string;
  eventId: string;
  revision: number;
  authorityEpoch: number;
  type: string;
  payload: T;
  simulationTimeMs: number;
};

/** 渲染态：只给 replica，不落盘、允许丢帧。 */
export type GameRenderState<T = unknown> = {
  protocol: 1;
  gameId: string;
  instanceId: string;
  revision: number;
  authorityEpoch: number;
  state: T;
  publishedAt: number;
};

/** `game:lifecycle` 载荷；`offlineMs` 只在 resumed 时出现。 */
export type GameLifecycleEvent = {
  gameId: string;
  instanceId: string;
  authorityEpoch: number;
  revision: number;
  state:
    | "started"
    | "stopped"
    | "suspended"
    | "resumed"
    | "authority-changed"
    | "failed";
  reason?: string;
  offlineMs?: number;
  error?: GameErrorBody;
};

/** `game_command_send` 的结果；`error` 是 Rust 侧的字符串错误码/原因。 */
export type GameCommandResult = {
  requestId: string;
  ok: boolean;
  result?: unknown;
  error?: string | null;
  revision?: number;
  deduplicated?: boolean;
};

/** `game_state_commit` 的结果；失败时 revision 为当前值。 */
export type GameCommitResult = {
  ok: boolean;
  revision: number;
  error?: GameErrorBody;
};

/** `game_connect` 的结果；实例未运行或无绑定时 context 为 null。 */
export type GameConnectResult = {
  context: GameContext | null;
  replicaId: string | null;
};

/** `games.json` 的公开形状；与 Rust `GamesConfig` 对应。 */
export type GamesConfig = {
  schemaVersion: number;
  autoStartWithWallpaper: boolean;
  resumeOnLaunch: boolean;
  maxRunning: number;
  offlineMaxMs: number;
  /** 启动游戏时自动打开清单声明的控制器（默认开）。 */
  controllerFollowsGame: boolean;
};

export const GAMES_CONFIG_DEFAULT: GamesConfig = {
  schemaVersion: 1,
  autoStartWithWallpaper: true,
  resumeOnLaunch: false,
  maxRunning: 3,
  offlineMaxMs: 7 * 24 * 3_600 * 1_000,
  controllerFollowsGame: true,
};

const OFFLINE_MIN_MS = 3_600_000;
const OFFLINE_MAX_MS = 30 * 24 * 3_600 * 1_000;

/** 容错归一化：文件损坏/浏览器预览返回非对象时回落到默认值。 */
export function normalizeGamesConfig(value: unknown): GamesConfig {
  if (typeof value !== "object" || value === null) {
    return { ...GAMES_CONFIG_DEFAULT };
  }
  const record = value as Record<string, unknown>;
  const maxRunning =
    typeof record.maxRunning === "number" && Number.isFinite(record.maxRunning)
      ? Math.min(3, Math.max(1, Math.round(record.maxRunning)))
      : GAMES_CONFIG_DEFAULT.maxRunning;
  const offlineMaxMs =
    typeof record.offlineMaxMs === "number" &&
    Number.isFinite(record.offlineMaxMs)
      ? Math.min(
          OFFLINE_MAX_MS,
          Math.max(OFFLINE_MIN_MS, Math.round(record.offlineMaxMs)),
        )
      : GAMES_CONFIG_DEFAULT.offlineMaxMs;
  return {
    schemaVersion: 1,
    autoStartWithWallpaper:
      typeof record.autoStartWithWallpaper === "boolean"
        ? record.autoStartWithWallpaper
        : GAMES_CONFIG_DEFAULT.autoStartWithWallpaper,
    resumeOnLaunch:
      typeof record.resumeOnLaunch === "boolean"
        ? record.resumeOnLaunch
        : GAMES_CONFIG_DEFAULT.resumeOnLaunch,
    maxRunning,
    offlineMaxMs,
    controllerFollowsGame:
      typeof record.controllerFollowsGame === "boolean"
        ? record.controllerFollowsGame
        : GAMES_CONFIG_DEFAULT.controllerFollowsGame,
  };
}

const UNKNOWN_GAME_ERROR: GameErrorBody = {
  code: "unknown",
  message: "未知错误",
};

/** 把结构化 GameError、命令 rejection 或任意异常收敛成可展示的错误体。 */
export function toGameErrorBody(error: unknown): GameErrorBody {
  if (typeof error === "object" && error !== null) {
    const record = error as Record<string, unknown>;
    if (typeof record.code === "string" && typeof record.message === "string") {
      return {
        code: record.code,
        message: record.message,
        detail: typeof record.detail === "string" ? record.detail : undefined,
      };
    }
  }
  if (error instanceof Error) {
    return { ...UNKNOWN_GAME_ERROR, message: error.message };
  }
  return { ...UNKNOWN_GAME_ERROR, message: String(error) };
}
