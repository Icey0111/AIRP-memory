# 酒馆 AIRP 记忆系统 — 数据库设计 V3（三阶语义层：属性与元素）

> 版本：V3（在 V2 之上新增，schema_version = 3）
> 主题：性格、外貌、口癖、氛围等精细语义 —— 向量检索层
> 核心原则：**向量只做索引，原文一字不删；稳定的常驻 prompt，深层的按需检索**

---

## 1. 为什么这样设计

三阶数据（属性与元素）有一个根本性矛盾：

> 总结了 → 丢信息；不总结 → 上下文爆炸。

常见的错误解法是"全部 embedding，按需召回"。这会陷入持续的工程设计：召不准调 chunk 策略，调完调打分，模型对角色的认知还不稳定（性格忽胖忽瘦）。

V3 的解法是**存取分离 + 双层结构**：

```
观察块层 (attribute_chunks)  ──全量原文, 一字不删──► 按需向量检索 top-k
        │ 归纳 (derived_from_chunk_ids 可追溯)
        ▼
生效画像层 (character_profiles) ──小而稳──► 无条件常驻 prompt
```

- **画像层兜底**：性格、外貌核心几百字常驻，模型对角色永远不走样；
- **块层保真**：所有细节原文保留，被问到时向量捞回，可溯源、可深挖；
- **上下文不爆炸**：注入的永远只有"画像 + top-k 块"，而不是全量。

## 2. 防"吃书"：时效性设计

三阶是最容易发生设定漂移的层（"初见时的艾拉"和"现在的艾拉"都是真的，只是时期不同）。每个观察块带：

| 字段 | 语义 |
|---|---|
| `valid_from_event_id` / `valid_to_event_id` | 生效区间（挂在二阶事件上，与剧情时间线对齐；NULL = 一直生效） |
| `supersedes_chunk_id` | 覆盖链：新观察取代旧观察，旧块保留可查历史 |

**"当前生效"的标准查询**（已实测验证）：

```sql
SELECT id, content, embedding FROM attribute_chunks
WHERE entity_type = ? AND entity_id = ? AND is_active = 1
  AND id NOT IN (SELECT supersedes_chunk_id FROM attribute_chunks
                 WHERE supersedes_chunk_id IS NOT NULL)
  AND valid_to_event_id IS NULL;
```

检索默认只扫当前生效块；旧块留着回答"她以前是什么样的"这类历史问题。

## 3. 表结构：`attribute_chunks`

| 字段 | 说明 |
|---|---|
| entity_type / entity_id | 实体锚点：`person` / `location`，指向 V2 实体表 |
| aspect | 维度，不加 CHECK 保持可扩展。建议值：`personality` / `appearance` / `speech` / `habit` / `relationship` / `preference` / `scene` / `atmosphere` |
| content | **原文观察，一字不删** |
| embedding | Float32 数组序列化 BLOB，写入方负责生成；**它只是检索指纹** |
| valid_from/to_event_id, supersedes_chunk_id | 时效性（见上） |
| chat_id / memory_id / source_message_ids | 溯源三件套 |
| importance / access_count / last_accessed_at | 与一阶同口径，检索打分与衰减直接复用 |

`character_profiles` 新增 `derived_from_chunk_ids`（JSON 数组）：画像条目由哪些块归纳而来。空数组 = 人工填写；非空 = 全自动溯源。

## 4. 检索架构：三层混合，各管一段

embedding 对模糊语义强，但对**专名、否定、数字**弱（"没去过王都"和"去过王都"向量距离很近），所以绝不能纯向量：

| 查询意图 | 走哪层 | 方式 |
|---|---|---|
| 谁/何时/何地/因果 | V2 实体图 | 精确 JOIN |
| 专名/物品/技能 | V1 memories | FTS5 精确匹配 |
| 性格/氛围/关系质感/模糊回忆 | V3 chunks | 向量余弦 |

注入前统一打分排序：`score = w1·相关性 + w2·importance + w3·时间衰减 + w4·访问频率`，top-k 截断。（打分实现属后续版本，字段已全部就位。）

## 5. 工程选型（已定的务实路线）

| 决策 | 结论 | 理由 |
|---|---|---|
| 向量存取 | embedding 存 BLOB，内存暴力余弦 | 酒馆单机量级（千级块）毫秒可完成；避免 sqlite-vec 的 Windows native 编译坑 |
| 切换时机 | 块数 > 10k 再评估 sqlite-vec | 届时数据不用动（BLOB 原样可读），只换检索实现 |
| embedding 模型 | 先走 API（用户已有 key），本地小模型（bge-small 等）后置 | 零安装门槛优先 |
| 维度约定 | 不写死在 schema | 换模型时整列重算即可，content 原文在，重建零损失 |

## 6. 写入路径（后续版本实现，结构已支持）

```
对话 → 一阶 memories (文本+FTS)
     → 二阶 六要素抽取 (实体/事件/因果)
     → 三阶 属性观察切块 (content + embedding + 实体锚点)
        ├─ 与既有块同实体同 aspect 且语义重复 → 合并或 supersedes
        └─ 画像层按 derived_from_chunk_ids 定期重归纳
```

## 7. 验证情况

- `db/schema.sql` 已合并为完整 V3，全新部署实测通过（schema_version=3）
- `db/migrations/002_v2_to_v3.sql` 实测通过，V1→V2→V3 迁移链完整验证
- 暴力余弦检索原型实测：过期块/被覆盖块正确排除，语义近的性格块排在语义远的外貌块之前，画像溯源链完整
