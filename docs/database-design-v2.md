# 酒馆 AIRP 记忆系统 — 数据库设计 V2（语义实体层）

> 版本：V2（在 V1 之上新增，不改动 V1 任何表）
> 主题：语义细化 —— 人物、时间、地点、起因、过程、结果 六大要素
> 模型：**以事件为枢纽的实体图**，表与表之间用外键/关系表互相指向

---

## 1. 核心思想

V1 的记忆是"一段段文本"。V2 把其中可结构化的部分抽出来，建成一张**实体图**：

```
                时间(time_points)
                      ▲
                      │ time_id
人物(people) ──参与──► 事件(events) ──位于──► 地点(locations)
                      │
        起因 ── event_links('caused') ──► 前置事件
        过程 ── events.process（正文）
        结果 ── result_text + event_links('led_to') ──► 后续事件
```

事件不是孤立的：它**指向**人物、时间、地点；事件之间再互相**指向**形成因果链。于是可以回答：

- 艾拉参与过哪些事件？（`event_participants` 反查）
- 夜莺酒馆发生过什么？（`events.location_id` 反查）
- "同行启程"是怎么发生的？（沿 `caused` 边回溯起因链）
- 第三夜之后发生了什么？（`time_points.seq` 顺序遍历）

---

## 2. 六要素与表的映射

| 要素 | 落点 | 说明 |
|---|---|---|
| 人物 | `people` + `event_participants` | 多对多，且带**角色**（发起者/参与者/受害者/目击者） |
| 时间 | `time_points` | 自由文本 label + 聊天内排序 seq |
| 地点 | `locations` | 支持层级（王国 > 城市 > 酒馆） |
| 起因 | `events.cause_text` + `event_links('caused')` | 双轨：叙述文本 + 指向前置事件的边 |
| 过程 | `events.process` | 事件正文 |
| 结果 | `events.result_text` + `event_links('led_to')` | 双轨：叙述文本 + 指向后续事件的边 |

**起因/结果为什么用"文本 + 边"双轨？**
起因经常不是另一个已登记事件（"因为暴雨"），这时只有文本；当起因确实是另一条事件时，加一条 `caused` 边就能形成可追溯的因果链。两条轨互不排斥，有多少填多少。

---

## 3. 新表详解

### 3.1 `people` — 人物实体

| 字段 | 说明 |
|---|---|
| name | 主称呼，全库唯一 |
| aliases | JSON 数组，别名/绰号。**归并靠它**："精灵游侠"和"艾拉"指向同一个人 |
| person_type | `main` 主角 / `npc` 登场 NPC / `mentioned` 仅被提及 |
| description | 人物速写（长期画像仍归 V1 的 `character_profiles`，职责分开） |

> 注意：`people` 与酒馆的角色卡解耦。酒馆的"当前角色"只是 people 里的一个 `main`；剧情里冒出的路人甲也是一条记录。

### 3.2 `time_points` — 剧情时间点

RP 时间通常无法解析成真实日期（"第三夜，暴雨"），所以用 **label + seq** 的方案：

- `label`：自由文本，注入 prompt 时直接用；
- `seq`：同一聊天内的排序序号，越大越晚——**排序与时间线回溯全靠它**；
- `chat_id`：时间线按聊天隔离，不同分支各走各的时间线；
- `parent_id`：可嵌套（某夜 ⊂ 第三章 ⊂ 第一卷）。

### 3.3 `locations` — 地点

- `aliases` 归并别名（"夜莺酒馆" = "酒馆"）；
- `parent_id` 自引用层级：查"王都发生的事"时可沿层级向下聚合所有子地点的事件。

### 3.4 `events` — 事件（枢纽表）

| 字段 | 说明 |
|---|---|
| title | 短标题，如"酒馆初遇"，注入 prompt 和列表展示用 |
| process / cause_text / result_text | 过程/起因/结果 三段叙述 |
| time_id / location_id | 指向时间、地点（SET NULL，实体删除不拖死事件） |
| chat_id | 事件必属于某条聊天/分支 |
| memory_id | 指向 V1 中来源的那条 `event` 类记忆（溯源，可空） |
| importance / emotional_weight | 与 V1 同口径，检索打分直接复用 |

### 3.5 `event_participants` — 参与关系

`event_id + person_id + role` 复合主键：同一个人可以在同一事件中有多重身份（既是"目击者"又是"受害者"）。

### 3.6 `event_links` — 事件因果链

| relation | 语义 |
|---|---|
| `caused` | from 是 to 的起因 |
| `led_to` | from 的结果是 to（caused 的反向表述，二选一即可，建议统一用 caused） |
| `preceded` | from 时间上先于 to（因果不明时的顺序补全） |
| `contradicts` | 两条事件叙述矛盾（吃书检测） |

### 3.7 `memory_entity_refs` — V1↔V2 引用桥

V1 的 `fact`/`summary` 记忆提到谁、在哪、关联哪个事件，登记在这里。检索时双向跳：记忆 → 实体，实体 → 所有相关记忆。**这是 V1 文本层和 V2 实体层之间的唯一桥，保持单层依赖，避免两网交织。**

---

## 4. 与 V1 的职责划分

| 层 | 存什么 | 类比 |
|---|---|---|
| V1 `memories` | 自然语言的记忆文本（事实/事件/摘要），全文检索 | "笔记本上写的话" |
| V2 实体层 | 从文本中抽出的结构化骨架（谁/何时/何地/因果） | "笔记本边上的索引标签" |

写入路径（后续版本实现）：对话 → 写入 `memories` → 抽取六要素 → 登记实体 + 建事件 + 连边 + 登记 `memory_entity_refs`。

---

## 5. 典型查询模式

```sql
-- 某人参与的所有事件(含时间地点)
SELECT e.title, t.label, l.name, p.role
FROM event_participants p
JOIN events e      ON e.id = p.event_id
LEFT JOIN time_points t ON t.id = e.time_id
LEFT JOIN locations l   ON l.id = e.location_id
JOIN people pe ON pe.id = p.person_id
WHERE pe.name = ? AND e.is_active = 1
ORDER BY t.seq;

-- 事件的起因链(向上回溯一层, 多跳可用递归 CTE)
SELECT e2.title FROM event_links k
JOIN events e2 ON e2.id = k.from_id
WHERE k.to_id = ? AND k.relation = 'caused';

-- 某聊天按时间线展开全部事件
SELECT t.label, e.title, e.process
FROM events e LEFT JOIN time_points t ON t.id = e.time_id
WHERE e.chat_id = ? AND e.is_active = 1
ORDER BY t.seq, e.created_at;
```

---

## 6. 本版已验证 & 文件位置

- `db/schema.sql` 已更新为完整 V2（全新部署直接执行），`schema_version = 2`
- `db/migrations/001_v1_to_v2.sql` 供已有 V1 库增量迁移
- 两项均已在内存库实测通过，包括"实体登记 → 事件 → 因果链 → 反查"端到端烟测

**V2 仍然不做**：抽取逻辑（LLM 从对话抽六要素的 prompt 与管线）、别名自动归并策略、图可视化 UI。结构就位，下一步可以做抽取管线。
