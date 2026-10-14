# 记忆网络图式 —— 节点是词汇，边是角色

> 状态: **已实现**（`server/src/services/graphProjection.js` + `server/public/graph.html`）。
> 上游: [`docs/verb-layer.md`](verb-layer.md)（原语模型：谓语是枢纽，题元是它的边）。
> 本文只定**视图层**：不改表结构、不改注入、不改抽取。
> 钉住本文不变式的是 `server/test/graph.smoke.js`。

---

## 1. 一句话

> **语义一律落成节点；每条边只写一个抽象词；连线上永远不出现拼接出来的句子。**

图是给人看的**词汇表**，不是给机器解析的**句子集**。谁做了、对谁做、何时何地、
真值归谁——这些各自都是图上一个可复用的节点；连线只回答一个字的追问：**它扮演什么角色**。

## 2. 要消灭的形态（为什么改）

上一版的「签名视图」把述谓实例整个释放掉了：事件不是节点，而是把
`label · 谓词 · 世界时间` 拼成一句话，盖在实体与实体之间的连线上：

```
你 ────── 主角苏醒 · 发现 · 夜晚, 深渊暗潮侵袭之时 ×2 ────── 发现(谓词枢纽)
                    ↑ 一句话，而且同一条线上还叠着 ×N 束
```

三处结构性问题，都不是审美问题：

| 病 | 后果 |
|---|---|
| **语义被压成字符串** | `主角苏醒`／`发现`／`夜晚…` 本可以是三个可复用节点，被压进一个字符串后，谁都不再能被单独复用、检索、着色、点击 |
| **唯一性丢失** | 谓词枢纽（`发现`）是全局的：所有"发现"都挂它，于是同一时刻的两次发现只能靠 `×2` 这种计数区分，实例身份名存实亡 |
| **线的信息密度不可读** | 线上文字随边数线性增长，实体一多就糊成一片（截图那面灰墙），而线本身该有的结构（角色）反而看不见 |

根因：**事件（述谓实例）被当成"派生视图"折叠掉了**。它是派生的，但它同时是
**这个网络里唯一不可复用的结构节点**——簇的锚点。锚点可以隐藏，不能没有。

## 3. 三条硬规则

### R1 语义落节点 —— 线上零句子

任何一项语义（谁 / 何时 / 何地 / 做什么 / 真值 / 情态 / 方面）都必须有**一个节点承载它**。
连线上允许出现的全部内容 = 一个来自封闭词表的抽象词。禁止拼接、禁止计数后缀（`×N`）、
禁止把标题/过程/结果这类自由文本画到画布上（它们在侧栏与悬浮里读）。

### R2 节点分两层，抽象层必须可复用

| 层 | 是什么 | 复用性 | 标签来源 |
|---|---|---|---|
| **词表节点** | 谓词 / 角色 / 时间 / 真值 / 情态 / 指称 | **全图共享**，每个节点带 `count` = 被多少个实例引用 | `domain/constants.js`（单一语义源） |
| **实例节点** | 述谓实例（谓语是枢纽） | 不复用（它就是个体） | 只写**谓词** + 通路坐标 `#seq.k` |

抽象层的复用度是**可量化**的检验口径：角色节点全图至多 8 个、真值至多 7 个、
情态至多 8 个、谓词取受控词表 —— 若某个"抽象"节点只被一个实例引用，
它要么该并回实例（不抽象），要么说明它其实是实例（label 混进来了）。

### R3 保留最基本的语义逻辑

题元结构 + 因果/条件/择一 + 立场，**一个都不省**。省的是句子，不是逻辑：

```
                    ┌─发起者──▶ 你
                    │
   深渊暗潮 ◀─对象── ⟨#3.2 发现⟩ ──谓词──▶ [发现]        (词表节点, count=7)
                    │
                    ├─时间──▶ [夜晚, 深渊暗潮侵袭之时] ──父级──▶ [第三章]
                    └─真值──▶ [叙述者事实]
```

读法：**实例是枢纽，词表是它的边端**。点 `[发现]` = 所有"发现"实例（复用）；
点 `⟨#3.2⟩` = 这一次发现（唯一）；从实例沿角色边走一步 = 谁/对谁/何时/何地。

## 4. 节点层（7 类）

| kind | 节点 | 来源 | 典型规模 | 复用 |
|---|---|---|---|---|
| `p` / `l` / `o` / `i` | 人物 / 地点 / 组织 / 物品 | `people` `locations` `orgs` `items` | 多 | 跨实例 |
| `t` | 时间（可嵌套章节） | `time_points` | 少 | 跨实例 |
| `k`（投影里的 `periods`） | **时段**（昼/夜/黄昏…） | `time_points.period_id` → `value_nodes(kind='time')` | ≤ 10 | **全图** |
| `v` | **谓词** | `events.verb_type` | 受控词表 ~20 | **跨实例** |
| `r` | **题元角色** | `VERB_LAYER.thematicRoles` | ≤ 8 | **全图** |
| `s` | **真值** | `VERB_LAYER.statuses` | ≤ 7 | **全图** |
| `m` | **情态／担保来源** | `source_type` + `attitude` | ≤ 8 | **全图** |
| `x` | **述谓实例** | `events` 一行 | 多 | 不复用（结构锚点） |

极性（`+ / −`）不单独成层：它是实例自身的属性，画成实例上的一个 `¬` 记号即可
（一个二值枚举做成节点只会让图更吵）。

## 5. 边层（只写一个词）

| kind | 从 → 到 | 线上那个词 | 词表出处 |
|---|---|---|---|
| `role` | 实例 → 指称 | 发起者 / 对象 / 与事 / 受害者 / 目击者 / 工具 / 提及 | `thematicRoles` |
| `pred` | 实例 → 谓词 | 谓词 | `verb_type` |
| `time` | 实例 → 时间 | 时间 | `time_points.label` |
| `place` | 实例 → 地点 | 地点 | `locations.name` |
| `truth` | 实例 → 真值 | 真值 | `statuses.short` |
| `modal` | 实例 → 情态 | 情态 | `sources` / `attitudes` |
| `link` | 实例 → 实例 | 起因 / 引出 / 前承 / 矛盾 / 条件 / 择一 | `INJECTION_TABLES.linkLabels` |
| `nest` | 实例 → 实例 | 命题宾语 / 条件前件 / 择一候选 | `VERB_LAYER.parentRoles` |
| `hold` | 实例 → 指称 | 持有者 | 归属命题必须能指回"谁说的"（`source_person_id`） |
| `parent` | 时间 → 时间 | （无词） | `time_points.parent_id` 章节嵌套 |
| `stance` | 指称 → 指称 | 立场词 + 强度 | `stances.stance_type` |
| `obs` | 实例 → 指称 | 方面词（`habit` / `scene`…） | `attribute_chunks.aspect` |

`obs` 的正文（`content`）是**载荷不是语义**：它是这条边的数据，进侧栏，不上画布。

## 6. 投影契约（`GET /api/graph`）

只读、无副作用、**不进 `ENDPOINTS` 契约**（不参与注入/抽取，冻结区不消费它）。

```jsonc
{
  "ok": true, "schema": "graph-view/v2", "chatId": null,
  "chats": [{ "chatId": "…", "events": 12, "memories": 30 }],
  "nodes": {
    "people":     [{ "id": 1, "name": "你", "aliases": [], "type": "main", "description": "" }],
    "locations":  [{ "id": 1, "name": "国门", "aliases": [], "description": "" }],
    "orgs": [], "items": [],
    "timePoints": [{ "id": 1, "label": "第三夜, 暴雨", "seq": 3, "parentId": null,
                     "note": "临近戌时三刻落闸", "periodId": 201, "periodName": "夜", "count": 4 }],
    "periods":    [{ "id": "夜", "word": "夜", "nodeId": 201, "count": 9, "label": "夜",
                     "parentName": "夜", "status": "ok", "aliases": ["夜里", "夜晚", "入夜"] }],
    "predicates": [{ "id": "发现", "word": "发现", "nodeId": 12, "count": 7, "label": "发现",
                     "parentName": "感知", "status": "ok", "source": "seed",
                     "aliases": [], "surfaces": ["察觉", "注意到"] }],
    "roles":      [{ "id": "发起者", "label": "发起者", "count": 19 }],
    "truths":     [{ "id": "asserted", "label": "事实", "full": "叙述者事实", "count": 30 }],
    "modalities": [{ "id": "narrator", "label": "叙述者断言", "count": 30 }],
    "instances":  [{
      "id": 4, "order": 4, "coordinate": "#3.2",
      "predicate": "发现", "verbSurface": "察觉", "predicateUnknown": false,
      "polarity": "+", "tense": "past", "status": "asserted",
      "sourceType": "narrator", "attitude": null, "sourcePersonId": null,
      "modality": "narrator", "truth": "asserted",
      "timeId": 1, "locationId": 2, "confirms": 1, "importance": 0.6,
      "parentInstanceId": null, "parentRole": null,
      "title": "主角苏醒", "process": "…", "resultText": "…"   // 载荷: 侧栏/悬浮, 不上画布
    }]
  },
  "edges": {
    "roles":    [{ "instance": 4, "entity": 1, "entityType": "person", "role": "发起者", "label": "发起者" }],
    "predicates": [{ "instance": 4, "predicate": "发现" }],
    "times":    [{ "instance": 4, "time": 1 }],
    "places":   [{ "instance": 4, "place": 2 }],
    "truths":   [{ "instance": 4, "truth": "asserted" }],
    "modalities": [{ "instance": 4, "modality": "narrator" }],
    "links":    [{ "from": 3, "to": 4, "relation": "caused", "label": "← 起因" }],
    "nesting":  [{ "parent": 7, "child": 8, "role": "comp", "label": "命题宾语（从句）" }],
    "timeParents": [{ "child": 2, "parent": 1 }],
    "holders":  [{ "instance": 8, "entity": 2, "entityType": "person", "label": "持有者" }],
    "stances":  [{ "holderType": "person", "holderId": 2, "targetType": "person", "targetId": 1,
                   "stanceType": "戒备", "intensity": 0.8, "basis": "盘查来路", "fromEvent": 4 }],
    "observations": [{ "entityType": "person", "entityId": 2, "event": 4,
                       "aspect": "habit", "content": "…80 字截断…" }]
  }
}
```

两条契约纪律：

1. **词表一律带 `label`**，取自 `domain/constants.js`。图页面不写第二份词表
   （与"前端零语义"同一条纪律，只是这里的"前端"是服务端自己发的静态页）。
2. **实体集合 = 被边引用过的实体**。没被任何边引用过的实体不进图，否则全库实体会涌进来。

V10 起，词表层（`predicates`/`roles`/`truths`/`attitudes`/`clauses`/`aspects`/`stanceTypes`/`periods`）
**直接读 `value_nodes`**（库里真实存在的元素），带 `nodeId`（元素 id）、`aliases`（同义写法）、
`parentName`（上位类，谓词与时段专用，如 `黄昏→夜`）、`status`（`ok`/`needs_review`）；
`count` 是**本图内**的引用数（按已经查出来的边现算 —— 切到单个聊天时不能把别的聊天的复用度算进来）。
实例侧带 `predicateId`/`attitudeId`/`clauseId`/`statusId`，真假判定就是按这些 id 判"同不同一个词"。
时间点带 `periodId`/`periodName`（时段抽象层）与 `parentId`（章节层级）。

## 7. 渲染规则

| 项 | 规则 |
|---|---|
| 形状 | 词表节点 = 圆（大小 ∝ √度数）；实例节点 = **小菱形**（结构锚点，别抢视觉权重） |
| 实例标签 | **谓词**（+ 极小的坐标 `#3.2`）；标题只在悬浮/侧栏 |
| 线标签 | `role` / `pred` / `time` / `place` / `truth` / `modal` / `obs` 各画**一个词**；`k ≥ 0.85` 或高亮时显示（缩太小则省，避免糊） |
| **待审词** | `status = needs_review` 的词表节点画**琥珀虚线框** —— 图直接告诉你"哪些词该整理了"（`node src/cli/vocab.js report` 看全量） |
| 图层开关 | 角色 · 谓词 · 时间 · 地点 · 真值 · 情态 · 因果(含嵌套) · 立场 · 观察；默认开：角色/谓词/时间/地点/因果/立场 |
| **角色节点化** | 可选开关：把 `role` 边上的词换成**共享的角色节点**（全图 ≤ 8 个，线上彻底零文字）。默认关——它让"复用"变得可见，也让每个角色成为高度数十的大枢纽 |
| 仅事实 | 隐藏 `source_type ≠ narrator` 的实例（对齐 `v_facts` 口径），其边一并隐藏 |
| 时间轴 | 滑杆 = 实例的 `order`（世界内时间序），回放即逐条长出实例 |

## 8. 不变式（`server/test/graph.smoke.js` 钉住）

1. **线上零句子**：任何边的 `label` 必须是单个词（不含 `·`、不含 `×`、无空白拼接）。
2. **语义不缺**：`instances × (谓词 + 时间 + 至少一个角色)` 的覆盖率 = 100%（缺谓词/时间的实例以 `未归一` / `未定时` 占位，不静默丢弃）。
3. **抽象层复用得起来**：`roles` / `truths` / `modalities` 的 id 必须落在 `constants` 词表内；`predicates` 只来自实例。
4. **实例唯一**：每个实例恰好一条 `pred` 边、恰好一条 `truth` 边；`coordinate` 在同一时间节点内唯一。
5. **实体边界与 `chatId` 隔离**：未被边引用的实体不进图；别的聊天的事件/实例不进来。
6. **锚点可回溯**：`stance.fromEvent` / `observations.event` 都指向本图内的实例。

## 9. 非目标

- **不动存储**：`events` / `event_participants` / `time_points` / `event_links` / `stances` / `attribute_chunks`
  已经是这套原语模型，本图只是把它画出来，不加列、不加表。
- **不做实体归并**：图是只读视图，"X 是 Y"的判定仍只归抽取层（见 verb-layer §5.3）。
- **不把摘要/画像/记忆条画进来**：它们是路径压缩视图，不是原语（README §设计主线）。
- **不做编辑**：这个页面的职责是**看清网络**，写入路径是抽取管线，不在这里开口子。

## 10. 与既有文档的接缝

| 文档 | 关系 |
|---|---|
| [`verb-layer.md`](verb-layer.md) §1 推论"事件是簇视图" | **互补**：实例节点就是簇的锚点；簇的成员 = 挂在它身上的角色/时间/地点边 |
| [`verb-layer.md`](verb-layer.md) §4 原语模型 | 本文是它的**图形直译**：三根正交轴 → `truth` / `modal` 两个词表层，极性 → 实例记号 |
| [`injection-tables.md`](injection-tables.md) | 注入表格是同一网络的**四种邻接投影**；图是原始形态，两者同源同构 |
| [`api.md`](api.md) | `/api/graph` 不进 `ENDPOINTS` 契约（不参与注入/抽取，冻结区不消费） |
