# 酒馆 AIRP 记忆系统 — 数据库设计 V1

> 版本：V1（首个版本）
> 目标：只定义数据库数据结构，不含检索实现、不含 UI、不含遗忘任务
> 存储引擎：SQLite 3.35+（FTS5）

---

## 1. 设计目标

为 SillyTavern（酒馆）AIRP 场景提供一个**可长期累积、可检索、可追溯、可遗忘**的记忆存储层：

1. 记住角色互动中产生的**事实、事件、摘要**三类记忆；
2. 支持按 **角色 / 聊天 / 全局世界观** 三个作用域隔离记忆；
3. 每条记忆带**重要度、情绪强度、访问统计**，为后续检索打分与遗忘衰减提供原料；
4. 支持记忆之间的**关联、替代、矛盾**关系，处理设定演化与冲突；
5. 预留向量检索位，V1 不实现，V2 直接补列即用。

### 选型说明

| 决策 | 结论 | 理由 |
|---|---|---|
| 存储引擎 | SQLite（better-sqlite3） | 本地单用户、零运维、事务完整；FTS5 内置；V2 可挂 sqlite-vec 做向量 |
| 三类记忆 | 单表 + `type` 字段 | 检索一次查全，加类型不用建表 |
| 作用域 | `scope` 字段 + 角色/聊天 id | RP 记忆的可见性天然分层，放一张表查询路径最短 |
| 软删除 | `is_active` 标志 | "遗忘"不等于物理删除，可回溯、可复活 |
| 全文检索 | FTS5 外部内容虚表 | 不重复存数据，触发器自动同步 |

---

## 2. 表结构总览

```
memories ─────────┬── memory_tags        (1 : N)  主题标签
   (核心记忆)      ├── memory_links       (自关联) 记忆间关系
                  ├── memories_fts       (1 : 1)  全文检索虚表(触发器同步)
                  └── retrieval_log      (1 : N)  检索命中日志

character_profiles  (独立)  角色长期稳定画像(结构化键值)

meta                (独立)  schema 版本号
```

---

## 3. 核心表详解

### 3.1 `memories` — 核心记忆表

| 字段 | 类型 | 说明 |
|---|---|---|
| id | INTEGER PK | 自增主键 |
| type | TEXT | `fact` 事实/设定 · `event` 剧情事件 · `summary` 对话摘要 |
| content | TEXT | 记忆正文（一段自然语言描述） |
| keywords | TEXT | 空格分隔关键词，FTS 检索时可单独加权 |
| importance | REAL 0~1 | 重要度，默认 0.5 |
| emotional_weight | REAL 0~1 | 情绪强度，高情绪的记忆更难遗忘 |
| scope | TEXT | `character` / `chat` / `global` |
| character_id | TEXT | 酒馆角色标识（scope=character 时必填） |
| chat_id | TEXT | 聊天/分支标识 |
| source_message_ids | TEXT (JSON 数组) | 来源消息 id，溯源用 |
| in_world_time | TEXT | 剧情内时间，自由文本（如"第三夜，暴雨"） |
| embedding | BLOB | **V1 预留，恒为 NULL**；V2 向量检索直接写入 |
| access_count | INTEGER | 被检索命中次数，遗忘机制原料 |
| is_active | INTEGER | 1=活跃，0=已遗忘（软删除） |
| created_at / updated_at / last_accessed_at | INTEGER | Unix 秒时间戳 |

**type 三类语义（写入方的约定）：**

- `fact`：稳定事实，如"主角是左撇子"、"酒馆老板讨厌精灵"。矛盾时通过 `memory_links` 的 `supersedes` 边处理。
- `event`：发生过的剧情事件，通常带 `in_world_time` 与来源消息。
- `summary`：一段对话或剧情节点的压缩摘要，是控制上下文长度的主力。

**scope 三作用域（检索时的过滤逻辑）：**

```
查询某聊天时可见的记忆 =
    scope='global'
  OR (scope='character' AND character_id=当前角色)
  OR (scope='chat' AND chat_id=当前聊天)
```

### 3.2 `memory_tags` — 标签

多值主题标签（"战斗"、"感情线"、"NPC"、"物品"），`memory_id + tag` 复合主键。用于人工筛选和检索时的主题过滤。

### 3.3 `memory_links` — 记忆间关系（自关联边表）

| relation | 语义 | 典型用途 |
|---|---|---|
| `related` | 一般相关 | 检索时联想扩展 |
| `caused` | 因果 | 事件链追溯 |
| `supersedes` | 新事实替代旧事实 | **处理设定矛盾**：旧记忆置 is_active=0，加替代边 |
| `contradicts` | 存在矛盾 | 标记冲突，留给人工或后续逻辑处理 |

### 3.4 `character_profiles` — 角色画像（结构化键值）

与 `memories` 的叙述性记忆**互补**：这里存"关于角色的长期稳定属性"，如 `对主角的态度 = 戒备中带好奇`。按 `(character_id, category, key)` 唯一约束，直接覆盖更新。适合注入 prompt 的"角色状态"区块。

建议 category：`personality` / `relationship` / `preference` / `appearance` / `state`。

### 3.5 `retrieval_log` — 检索日志（可选但建议建）

记录每次检索的 query、命中 id、打分。V1 不需要它参与查询，但**后续调权重、做遗忘机制都依赖这份数据**，从一开始积累成本为零。

---

## 4. 为后续版本预留的接口

| 机制 | 数据结构上的准备 | 预期版本 |
|---|---|---|
| 向量检索 | `memories.embedding` BLOB 列已预留；V2 挂 sqlite-vec 或独立向量表 | V2 |
| 遗忘/衰减 | `importance`、`emotional_weight`、`access_count`、`last_accessed_at` 已齐全；衰减只改 importance 或置 is_active=0 | V2/V3 |
| 检索打分 | 打分公式 `score = w1·相关性 + w2·importance + w3·recency + w4·频率` 所需字段已全部存在 | V2 |
| 中文分词 | FTS 当前用 `unicode61`，可平滑切换 jieba/simple 分词器（重建虚表即可） | V2 |
| 数据迁移 | `meta.schema_version` 已就位，后续版本按版本号增量迁移 | 持续 |

---

## 5. V1 明确不做的事

- ❌ 检索打分实现（结构已备好，逻辑下版做）
- ❌ 向量写入与召回（仅留列）
- ❌ 自动遗忘任务（字段已备好）
- ❌ 任何 UI / 酒馆扩展对接代码

---

## 6. 文件位置

- DDL：`db/schema.sql`（SQLite 可直接执行）
- 本设计文档：`docs/database-design-v1.md`
