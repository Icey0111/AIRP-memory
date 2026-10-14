# 酒馆 AIRP 记忆系统 — 数据库设计 V4（冻结补丁 + 相对立场层）

> 版本：schema 4 → 5，结构层**正式冻结**版本
> 内容：V3→V4 冻结补丁（物品/组织实体、embedding 元数据）+ V4→V5 相对立场层（stances）

---

## 第一部分：V3→V4 冻结补丁

结构评审时发现三个小缺口，其中两个"现在补成本为零、以后补要重建表"，已在冻结前修掉：

| 补丁 | 内容 |
|---|---|
| embedding 元数据 | `memories` / `attribute_chunks` 增加 `embedding_model TEXT`，换 embedding 模型时可精确区分重算范围 |
| 物品/组织实体 | 新增 `items`（含 `owner_person_id` 追踪持有者）与 `orgs` 表；`attribute_chunks` / `memory_entity_refs` 的 entity_type 放开 `item` / `org` |

第三个缺口（人物间关系）经讨论后不缓建——用户提出更准确的抽象：**相对立场**，即本版主体。

> 迁移注意：SQLite 不能 ALTER CHECK 约束，`003_v3_to_v4.sql` 对 `attribute_chunks` / `memory_entity_refs` 采用"建新表→拷贝→删旧→改名"重建，已验证旧数据零丢失、外键完整。

---

## 第二部分：stances 相对立场层

### 1. 核心概念

**关系是静态名词，立场是可演化的状态。** "艾拉和主角是同伴"是一张快照；"艾拉对主角持信任立场（0.7），源于生死与共，自事件 X 起生效"才是活的记忆。

### 2. 设计决策

**有向且不对称**：`holder → target`，A对B 与 B对A 是两条独立记录。

```
艾拉 ──信任(0.7)──► 主角      （生死与共后放下戒备）
主角 ──戒备(0.4)──► 艾拉      （精灵不可全信）
```

**一阶属性**：`stance_type`（信任/戒备/敌对/友好/爱慕/忠诚/敬畏/轻蔑……不锁死）+ `intensity` 0~1 程度。

**二阶属性**（本层精髓，RP 戏剧张力全在这里）：

| 字段 | 语义 | 能表达的场景 |
|---|---|---|
| `displayed_type` | 对外表现的立场，NULL=表里如一 | 伪装、演戏、笑里藏刀 |
| `is_public` | 公开/隐秘 | 地下恋情、暗中结盟 |
| `target_aware` | 对象是否知情 | 暗恋、被蒙蔽 |
| `basis` | 立场依据 | "觊觎主角的龙之剑" |

**多态端点**：holder/target 均支持 person/org，覆盖人对人、人对组织、组织对人、组织对组织（"银月商会对主角的通缉立场"）。

**时效**：与 attribute_chunks 完全同口径——`valid_from/to_event_id` + `supersedes_stance_id`，立场演化留痕可溯。

### 3. 表结构 `stances`

```
holder_type/holder_id  ──┐ 有向边, 自指被 CHECK 拒绝
target_type/target_id  ──┘
stance_type + intensity          一阶
displayed_type / is_public / target_aware / basis   二阶
valid_from/to_event_id / supersedes_stance_id       时效
chat_id / memory_id / source_message_ids            溯源
importance / is_active / 时间戳
```

### 4. 典型查询（全部实测通过）

```sql
-- 某人对某人当前生效的立场 (排除过期与被覆盖)
SELECT stance_type, intensity, displayed_type FROM stances
WHERE holder_type='person' AND holder_id=? AND target_type='person' AND target_id=?
  AND is_active=1 AND valid_to_event_id IS NULL
  AND id NOT IN (SELECT supersedes_stance_id FROM stances
                 WHERE supersedes_stance_id IS NOT NULL);

-- 谁对主角"笑里藏刀" (表≠里)
SELECT ... WHERE target_id=? AND displayed_type IS NOT NULL
  AND displayed_type <> stance_type;

-- 主角面临的全部敌对立场 (含组织)
SELECT ... WHERE target_id=? AND stance_type='敌对'
  AND valid_to_event_id IS NULL;
```

实测场景：不对称立场（艾拉信任 vs 主角戒备）、表里不一（商人表面友好实则敌对+主角不知情）、组织通缉、立场演化（戒备→信任 supersede 链）——行为全部符合预期。

### 5. 与既有层的关系

- **画像层**（character_profiles）：常驻 prompt 的"当前关系摘要"可从 stances 当前生效记录归纳生成；
- **观察块**（attribute_chunks aspect='relationship'）：立场背后的细碎片段（"她挡刀时喊了他的名字"）仍归块层，stances 是结构化骨架；
- **事件**：立场转变的成因用 `valid_from_event_id` 锚定，因果链可追溯。

---

## 结构层冻结声明

至此，数据要素七组（内容/结构/权重/溯源/时效/索引/迁移）全部齐备：

| 层 | 表 |
|---|---|
| 一阶 文本 | memories + FTS / memory_tags / memory_links |
| 二阶 六要素 | people / locations / time_points / events / event_participants / event_links / memory_entity_refs |
| 三阶 属性 | attribute_chunks / character_profiles |
| 实体扩展 | items / orgs |
| 立场 | stances |
| 运维 | meta / retrieval_log |

后续版本只碰**实现层**（写入管线、检索打分、遗忘衰减），数据结构不再新增——除非出现真实需求倒逼，且一律走迁移脚本增量演进。

迁移链：`001_v1_to_v2 → 002_v2_to_v3 → 003_v3_to_v4 → 004_v4_to_v5`，全链实测通过。

---

## V5 → V9 增量（均属"真实需求倒逼"的实现层演进，不新增表）

| 版本 | 迁移 | 加的东西 | 倒逼它的真实问题 |
|---|---|---|---|
| V5→V6 | 005 | events 动词槽与命题三轴（verb_type/verb_surface/polarity/source_type/source_person_id/attitude/tense/status/aligned_instance_id/parent_*） | "艾拉说明天去镇上"被抽成既成事实（把意图写成事实） |
| V6→V7 | 006 | stances 加 `stance_dimension` + `confirms` | 同槽位值变化是迁移还是并存，原先无从区分 |
| V7→V8 | 007 | attribute_chunks 加 `confirms` + `supersede_similarity` | 重复观察堆出一长串同值行（伪迁移） |
| **V8→V9** | **008** | **events 加 `label` + `confirms`，判等键带上来源窗口** | **事件被静默吞并（数据丢失）** |

### V9 详解：判等键为什么必须带来源窗口

events 的幂等判据长期是"同 chat 同 title"，而 title 曾被写成实例 label
（`title = label || verbSurface || verbType`）。合并抽取**每个窗口都从 e1 开始编号**，
于是第二段剧情里同样叫 e1 的实例被判"已存在" → 整条事件被静默丢弃。
2026-10-14 真实模型实测：窗口 1（艾拉出门）落 2 条，窗口 2（铁匠放剑）落 **0 条**。

修正后的判等键（`findEventForRestatement`）：

```
① title 相同 且 时间点相同        —— 描述性标题本身是内容, 跨窗口可比
② label 相同 且 来源窗口相同      —— label 是一次输出内的临时编号, 出了窗口就没有意义
③ 命中的含义是重述: 不新增行, confirms + 1 (与属性层/立场层对称)
```

同时 `title` 与 `label` **分列存**：描述性标题不再被 "e1" 顶掉
（历史数据按旧口径回填 `label = title`，旧库零漂移）。

**前提条件（不可省）**：判等只在实例**带 label** 时进行 —— 无 label 时 title 会回落到
动词（verbSurface/verbType），多条从句可能同为"去"，一判等就互相吞并（这条旧代码早已写明）。
