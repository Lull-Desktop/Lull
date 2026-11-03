# 智能随机（Smart Shuffle）

> 状态：v1 已落地；策略参数仍按模拟指标校准。本文记录三层边界、概率模型与校准方法。
>
> 用户可见参数只有五项：`randomness / diversity / repeatAvoidance / artist / album`。
> BPM、能量、情绪与偏好学习仍未开放；`audioFeatures` 只是版本化占位，不参与选曲。

## 1. 三层边界

```text
用户层 SmartShuffleProfile
  └─ player_shuffle_profiles / player_shuffle_active
       │  profile.config（五项参数）
       ▼
算法层 ShuffleStrategy
  ├─ ScoringModel：最近播放 / 歌手 / 专辑 / 曲风 / 收藏
  ├─ ConstraintModel：当前曲、近期硬窗口、可用性
  └─ WeightingModel：softmax + uniform 混合、归一化
       │  probabilities
       ▼
引擎层 ShuffleEngine
  ├─ update_tracks：列表/队列变化时维护轮次袋
  ├─ next / commit / abort：预占 → 播放成功才消耗名额
  ├─ previous：历史栈
  └─ reset：离开 shuffle
```

- 三层都不访问数据库；`playback` 负责加载 `ShuffleContext`、调用 `play` 并提交结果。
- Strategy/Engine 是 Rust 内部接口，不暴露到 `media_call`；公开 API 只有 Profile。
- 播放器只通过 SDK 读写 Profile；算法细节不进入前端。

## 2. 参数映射

| 参数 | 作用 |
| --- | --- |
| `randomness` | 归一化概率的 uniform 混合比例 `alpha=(r/100)^2`；不直接缩放惩罚 |
| `diversity` | 曲风惩罚指数 `0.45^(hits·diversity/50)` |
| `repeatAvoidance` | 最近 `round(repeat/100*4)` 首硬排除 + 软近期惩罚强度 |
| `artist` | 最近 N 首同歌手惩罚窗口 |
| `album` | 最近 N 首同专辑惩罚窗口 |

概率：`z = log_score - max`，`q = softmax(z/0.5)`，`p = (1-alpha)·q + alpha/n`。
`randomness=100` 在硬约束候选上严格均匀；`repeatAvoidance` 的硬窗口不会随 randomness 消失。

## 3. 轮次与上一首

- 一轮内不重复；播完自动开新一轮，当前曲进入新袋，由近期硬窗口避免立刻重播。
- `next` 先返回 `Selection` 并从 `remaining` 预占；播放成功 `commit`，失败 `abort` 放回。
- `previous` 走历史栈；没有历史时回退加权下一首。
- 列表分页/筛选保留进度；互不包含的列表变化重置轮次。轮次与历史栈只在内存。

## 4. Profile API

| 方法 | 说明 |
| --- | --- |
| `player.listShuffleProfiles` | 内置在前，标记 active |
| `player.getShuffleProfile` | `profileId` 可选，缺省激活项 |
| `player.saveShuffleProfile` | 创建/更新用户配置；内置拒绝修改 |
| `player.deleteShuffleProfile` | 删除用户配置；激活项回退 balanced |
| `player.activateShuffleProfile` | 切换激活项 |

`get/setSmartShuffleConfig` 保留为兼容别名。

## 5. 校准

模拟在 `media/playback/shuffle/simulation.rs`（`cargo test` 运行，合成 500 首）：

- 轮次覆盖 100%，无相邻重复；
- 默认 profile：`randomness=60` 下收藏曝光 lift ≈1.2，相邻同歌手 <1%，同专辑 <0.5%；
- `randomness=100` + `repeatAvoidance=100`：最近 4 首硬排除命中 0；
- 多样性优先的曲风相邻率不高于均衡随机；
- 输出 metrics 供继续调参；上线前再补充真实曲库听感与用户测试。

## 6. 后续

- 用真实曲库的分布校准 `alpha` 曲线、`tau`、近期软惩罚桶与硬窗口上限。
- 音频特征（BPM/能量/情绪）接入后，作为新的评分因子加入 Strategy，Profile 版本升到 v2。
- 如需“熟悉歌曲优先”，增加播放次数/偏好模型，而不是把更多算法参数暴露给用户。
