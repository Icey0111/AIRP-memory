# 记忆服务 API 参考

面向酒馆（SillyTavern）前端插件的对接文档。后端为本地 Node.js 服务，分层 `api → service → db`，本文档只描述 HTTP 契约，不涉及内部实现。

## 0. 运行与配置

```bash
cd server
cp config.default.json config.json   # 然后编辑填入真实配置
npm start                            # 监听 127.0.0.1:7780
npm test                             # 三套冒烟测试（内存库，不碰真实数据）
```

`config.json` 关键字段：

| 字段 | 说明 |
|---|---|
| `llm.provider` | `openai-compatible` 或 `mock` |
| `llm.baseUrl / apiKey / model` | OpenAI 兼容端点（官方/DeepSeek/中转均可） |
| `embedding.provider` | `openai-compatible` 或 `mock` |
| `embedding.baseUrl / apiKey / model` | 向量端点，维度不限（BLOB 存 Float32） |
| `db.path` | SQLite 文件路径，默认 `./data/memory.db` |
| `retrieval.topK` | `/api/retrieve`、`/api/context` 的默认 topK（默认 8，请求体可覆盖） |
| `retrieval.tokenBudget` | `/api/context` 的默认 token 预算（默认 1200，请求体可覆盖） |
| `server.host / port` | 默认 `127.0.0.1:7780`；改绑 `0.0.0.0` 供局域网/手机访问（服务无鉴权，仅建议在可信局域网使用；跨网访问建议走 Tailscale 等加密隧道） |
| `server.cors.enabled` | 是否下发 CORS 头，默认 `true`（前端插件跨源调用必需） |
| `server.cors.origins` | 额外放行的来源白名单（数组）。本机 `localhost` / `127.0.0.1` / `[::1]` 的任意端口始终放行 |

> LLM/embedding 未配置时服务照常启动，只有抽取类/向量类端点不可用，其余端点正常。

**跨源调用（CORS）**：酒馆页面（默认 `http://localhost:8000`）与记忆服务（`127.0.0.1:7780`）不同源，浏览器会拦截没有 CORS 头的响应。服务默认放行：

```
http(s)://localhost:<任意端口>
http(s)://127.0.0.1:<任意端口>
http(s)://[::1]:<任意端口>
+ config.server.cors.origins 里显式列出的来源
```

**绝不放行 `*`** —— 服务无鉴权，通配等于把整个记忆库暴露给任意网页。预检 `OPTIONS` 命中白名单返回 204 并回显来源，未命中返回 403；普通请求不受影响，只是不下发 CORS 头。设 `server.cors.enabled=false` 可整体关闭。实际生效策略可从 `GET /api/meta` 的 `cors` 字段读到（见 §12）。

## 1. 通用约定

> **前端插件请先读 §12 `GET /api/meta`。** 本服务的枚举与标签、打分权重与公式、阈值、生效默认值、错误文案、端点能力判断，全部由该端点下发。前端不得另存一份，否则两端语义必然漂移。

**响应包络**：所有端点返回 JSON，成功含 `"ok": true`；失败为

```json
{ "ok": false, "error": "错误描述" }
```

业务校验失败 HTTP 400，资源不存在 HTTP 404。

**时间戳**：所有 `created_at` / `updated_at` / `last_accessed_at` 为 Unix 秒。

**软删除**：DELETE 均为 `is_active = 0`，数据仍在库中，可通过 `/api/forget/restore` 恢复。

**可见性口径**（list/retrieve 共用）：

```
scope = 'global'                          → 所有上下文可见
scope = 'character' AND character_id 匹配  → 当前角色可见
scope = 'chat'      AND chat_id 匹配       → 当前聊天可见
```

**`source_message_ids`**：JSON 数组字符串，记录来源楼层号，供前端跳转/对账。

---

## 2. 运维

> 契约描述端点 `GET /api/meta`（前端唯一语义源）单独放在 §12。

### `GET /health`

```json
{ "ok": true, "service": "tavern-memory-server" }
```

### `GET /api/status`

返回 schema 版本与各表行数，用于自检。

```json
{
  "ok": true, "schemaVersion": 6, "latestSupported": 6,
  "counts": { "memories": 12, "attribute_chunks": 34, "stances": 5, "...": 0 }
}
```

---

## 3. 一阶记忆 `/api/memories`

三层记忆（fact 事实 / event 事件 / summary 摘要）的通用容器，带 FTS5 全文索引。

### `POST /api/memories`

```json
{
  "type": "fact",                      // 必填: fact | event | summary
  "content": "主角在第三夜向艾拉透露了身世",   // 必填
  "keywords": "身世 秘密",              // 可选, FTS 权重高于 content
  "scope": "chat",                     // 可选: character | chat | global, 默认 chat
  "characterId": "艾拉",                // scope=character 时必填
  "chatId": "chat001",
  "importance": 0.7,                   // 0~1, 默认 0.5
  "emotionalWeight": 0.4,              // 0~1, 默认 0
  "inWorldTime": "第三夜, 暴雨",         // 可选, 剧情内时间标签
  "sourceMessageIds": ["m31", "m32"],
  "tags": ["关键转折"]
}
```

返回 `{ "ok": true, "memory": { ...完整行, "tags": [...] } }`。

### `GET /api/memories`

查询参数：`chatId` `characterId` `scope` `type` `includeInactive=1` `limit`(默认 50) `offset`。

### `GET /api/memories/:id` → `{ ok, memory }`，不存在 404。

### `PATCH /api/memories/:id`

可改字段：`content` `keywords` `importance` `emotionalWeight` `inWorldTime` `isActive` `tags`（tags 为全量替换）。

### `DELETE /api/memories/:id` → 软删。

---

## 4. 生效画像 `/api/profiles`

角色画像常驻注入层，每条为 `(character_id, category, key)` 唯一。

### `GET /api/profiles/:characterId`

```json
{ "ok": true, "profile": [
  { "character_id": "艾拉", "category": "personality", "key": "行事风格",
    "value": "冷静谨慎, 先观察再行动", "derived_from_chunk_ids": "[3,7]", "updated_at": 1791860000 }
]}
```

`derived_from_chunk_ids` 非空 = 由观察块自动归纳（溯源）；空数组 = 人工填写。

### `PUT /api/profiles/:characterId`

```json
{ "category": "appearance", "key": "眼睛", "value": "翠绿色", "derivedFromChunkIds": [] }
```

upsert 语义：同 (category, key) 覆盖。

### `DELETE /api/profiles/:characterId` — body `{ "category", "key" }`。

---

## 5. 检索与注入

### `POST /api/retrieve` — 三路召回（FTS 记忆 + 向量观察块）

```json
{ "query": "艾拉的性格", "chatId": "chat001", "characterId": "艾拉", "topK": 8, "withChunks": true }
```

```json
{
  "ok": true, "match": "\"艾拉的性格\"",
  "hits":      [ { "id": 5, "type": "fact", "content": "...", "relevance": 1.0, "score": 0.94, "...": "..." } ],
  "chunkHits": [ { "id": 3, "aspect": "personality", "content": "...", "similarity": 0.81, "score": 0.88, "...": "..." } ],
  "digest":    { "text": "【前情提要】\n[24-35] ...", "count": 4, "total": 6, "tokens": 1180,
                 "maxTokens": 2000, "truncated": true, "droppedCount": 2,
                 "ids": [41, 44, 47, 50], "fromFloor": 24, "toFloor": 71 }
}
```

打分框架统一：`score = 0.6·相关性 + 0.25·importance + 0.15·时间新近度`。
`withChunks=false` 或未配置 embedding 时无 `chunkHits` 字段。

**默认排除摘要记忆**（`type='summary'`）：摘要不在相似度召回里竞争，而是走【前情提要】常驻段（见下）。传 `includeSummaries: true` 才把它们放回 `hits`。

`digest` 就是 `/api/context` 会注入的**同一份**摘要链 —— 调试时据此确认"被隐藏的剧情到底以什么形式还在场"。

### `POST /api/context` — 注入组装（**前端主入口**）

```json
{ "query": "最近发生了什么", "chatId": "chat001", "characterId": "艾拉",
  "topK": 8, "tokenBudget": 1200, "digestMaxTokens": 2000,
  "injectTables": true, "injectStances": true, "injectPending": true }
```

```json
{
  "ok": true,
  "text": "【当前时间】2026年10月14日星期三 21:49\n\n【角色画像】\n…\n\n【前情提要】\n[2026年10月14日星期三 21:28 · 2-4] 国门盘查：…\n\n【事件时间线】\n…\n\n【待兑现】\n- 信使说：带主角去北门（未决 · 2026年10月14日星期三 21:49）\n\n【相关记忆】\n…",
  "injectionMode": "tables",
  "usedTokens": 412, "tokenBudget": 1200,
  "clockAt": 1791985754, "clockInferred": true,
  "clockText": "【当前时间】2026年10月14日星期三 21:49",
  "profileCount": 2, "stanceCount": 3, "entityCount": 5,
  "timelineCount": 8, "propositionRows": 1,
  "pendingCount": 1, "pendingTotal": 2, "pendingTokens": 40, "pendingDropped": 1, "pendingEnabled": true,
  "hitCount": 3, "hitIds": [5, 9, 2], "chunkHitCount": 2, "chunkHitIds": [3, 7],
  "digestCount": 4, "digestTotal": 6, "digestTokens": 1180, "digestMaxTokens": 2000,
  "digestDropped": 2, "digestTruncated": true
}
```

`text` 直接拼进 prompt 即可。段落顺序与 `meta.contextSections` 同源（V10 起为 9 段）：

| # | 段 | 填充方式 | 预算 |
|---|---|---|---|
| 1 | 当前时间 | 常驻（一行）；**只放精确时间戳**（`2026年10月14日星期三 21:49`），基准是最近一条记录的写入时间，来源差异只经 `clockInferred` 上报、不进 prompt | 不计预算 |
| 2 | 角色画像 | 常驻（表格） | 自有 |
| 3 | 关系立场 | 常驻（表格，可关） | 自有 |
| 4 | 关键实体 | 常驻限量（表格） | 自有 |
| 5 | 前情提要 | 常驻，按楼层顺序拼接的摘要链；行首 `[精确时间戳 · 起-止]` | `digestMaxTokens` |
| 6 | 事件时间线 | 常驻限量；时间列是精确时间戳（同一节点只出现一次）；**归属声称带来源口吻与定局标记**（`信使说：…（已被拆穿）`） | 自有 |
| 7 | **待兑现** | 常驻限量；未决命题（承诺/约定/威胁/线索），时间锚为精确时间戳，**空则不出段**，可关 | 自有 |
| 8 | 相关记忆 | FTS 召回，**已排除摘要**，按打分填 `tokenBudget` | `tokenBudget` |
| 9 | 相关细节 | 向量召回的观察块，填剩余 `tokenBudget` | 同上 |

**预算是分开的**：`usedTokens / tokenBudget` 只表示第 8、9 段（检索段）的用量；各常驻段走自己的预算（见 `meta.injectionTables.budgets`），互不挤占。

分开的理由：常驻段承载的是"必然在场"的信息（角色是谁、关系怎样、发生了什么、还欠着什么），一旦与"当前更像"的记忆抢同一个预算，它们会被挤掉 —— 而被挤掉的那一刻，那段信息在模型眼里就凭空消失了。

V6 新增的两条注入口径（`meta.verbLayer` 下发）：

- **时间线只收已发生的**：归属声称在**已定局**（已证实 / 已被拆穿）时内联进时间线并带来源口吻；**未决**的进【待兑现】；**未发生**的（落空/未激活/作废）两边都不进。
- **子实例不成独立行**：从句/条件前件/择一候选的内容由宿主行承载（否则「她说：X」与 X 会各占一行）。

> 为什么摘要不走相似度、预算不足时为什么"保新丢旧"，见 [summarization.md](./summarization.md) 第 5 节。

---

## 6. 述谓实例抽取 `/api/extract`（V6 起）

对话文本 → **述谓实例**（谁—动词—谁 + 来源/时态/极性）/ 人物 / 地点 / 时间点 / 因果与条件边。
幂等（同 chat 同 `label` 的实例不重复落库；无 label 的实例不去重 —— 两条从句可能同为「去」）。

```json
{ "chatId": "chat001", "text": "<若干层对话原文>", "sourceMessageIds": ["m30","m31"], "writeMemory": true }
```

```json
{
  "ok": true,
  "people": [ { "id": 1, "name": "艾拉", "existed": true, "...": "..." } ],
  "locations": [ { "id": 1, "name": "夜莺酒馆", "...": "..." } ],
  "timePoint": { "id": 3, "label": "第三夜, 暴雨", "seq": 3 },
  "instances": [ { "id": 2, "title": "同行启程", "verbType": "去", "sourceType": "narrator", "existed": false } ],
  "links": [ { "from": "酒馆初遇", "to": "同行启程", "relation": "caused" } ],
  "memoryIds": [11, 12],
  "skipped": 0,
  "aligned": { "realized": [], "refuted": [], "hostRealized": [], "hostRefuted": [], "inactive": [], "failed": [], "voided": [] },
  "extracted": { "...": "LLM 原始 JSON" }
}
```

三条与旧版不同的语义（详见 `docs/verb-layer.md`）：

| 规则 | 说明 |
|---|---|
| **来源** | `source_type='narrator'` 进事实层（`v_facts`）；`'attributed'`（人物说的/想的）进命题层（`v_propositions`），状态未决 |
| **从句/条件前件继承宿主来源** | 「艾拉说[她明天去镇上]」里的从句也是归属内容，**不会**被写成事实 |
| **归并触发权** | 只有叙述者断言可触发实体别名归并；人物层的「X 是 Y」落为命题（写入时用 `mergeAliases:false` 兜底） |

`writeMemory=false` 时只建图不写一阶事件记忆；归属命题**从不**写一阶记忆（不污染 FTS 检索）。
落库后自动跑一轮对齐（命题 ↔ 事实），失败只记 warn，不影响抽取结果。

---

## 7. 三阶属性观察块 `/api/chunks`

细粒度属性（性格/外貌/习惯…）的存取分离层：原文一字不删 + embedding 索引。

### `POST /api/chunks` — 手动写入（已配置 embedding 时自动补向量）

```json
{
  "entityType": "person", "entityId": 1,     // person | location | item | org
  "aspect": "personality", "content": "艾拉性格冷静, 遇事先观察再行动",
  "chatId": "chat001", "importance": 0.8,
  "validFromEventId": null, "validToEventId": null,
  "memoryId": null, "sourceMessageIds": []
}
```

→ `{ "ok": true, "id": 3, "embedded": true }`

### `GET /api/chunks?entityType=person&entityId=1[&includeHistory=1]`

默认只返回**当前生效**块（未删除 + 未过期 + 未被覆盖）；`includeHistory=1` 返回全量含历史。
响应不含 embedding BLOB，以 `hasEmbedding` 标记。

### `DELETE /api/chunks/:id` → 软删。

### `POST /api/extract-attributes` — 三阶抽取管线（LLM + embedding）

```json
{ "chatId": "chat001", "text": "<对话原文>", "sourceMessageIds": ["m40"] }
```

```json
{ "ok": true, "skipped": 0, "chunks": [
  { "id": 4, "entityType": "person", "entityName": "艾拉", "aspect": "personality",
    "content": "...", "operation": "update", "confirms": 0, "supersedes": 3, "similarity": 0.9123 }
]}
```

自动行为：实体 find-or-create 归并 → 批量 embedding → **槽位判定**（V8）→ 事务落库。`item`/`org` 类型观察暂跳过并计入 `skipped`。

**V8 三种结构操作**（`operation` 字段，标签见 `meta.enums.slotOperation`）：

| operation | 条件 | 存储行为 |
|---|---|---|
| `create` | 同槽位没有语义相近的生效块 | 写一行（唯一写文本处） |
| `confirm` | **规范化后文本完全相同**（NFKC → 小写 → 只留字母/数字/汉字；标点/空白/全半角差异都不算变） | **不新增行**，`confirms + 1`，来源楼层并入 |
| `update` | 措辞变了，且与某生效块余弦 ≥0.85 | 写新行，`supersedes` 指向前驱，`supersede_similarity` 留档余弦 |

判据是**确定性的**：相似度只决定"是不是同一条属性"（建不建链），规范化判等决定"值动没动"。
措辞变化可能带新细节，宁可多存一行也不丢细节 —— 重述判据详见 `meta.slotModel.restatement`。

### `POST /api/profiles-derive` — 画像重归纳

```json
{ "personId": 1, "characterId": "艾拉" }
```

取该人物当前生效的全部观察块 → LLM 归纳 → upsert 进 `character_profiles`（带 chunk 溯源）。

---

## 7.5 模型配置 `/api/config`

模型与密钥的**可视化填写入口**。安全模型：密钥**只在服务端落盘**（`server/config.json`，已 gitignore），
前端只做输入壳 —— 读取一律打码（`••••`+末4位，只供辨认，不可还原），密钥输入框从不回填明文。
保存后**深合并写盘 + 热重建客户端**，无需重启服务。只接受 `llm` / `embedding` 两节，
其余配置（端口/数据库路径/CORS）只能改文件并重启。

### `GET /api/config`

```json
{ "ok": true,
  "config": {
    "llm": { "provider": "openai-compatible", "baseUrl": "https://…/v1", "model": "…",
             "apiKey": "••••••••9999", "apiKeySet": true, "timeoutMs": 60000 },
    "embedding": { "provider": "openai-compatible", "baseUrl": "", "model": "", "apiKey": "", "apiKeySet": false }
  },
  "llm": { "configured": true, "provider": "openai-compatible", "model": "…", "timeoutMs": 60000 },
  "embedding": { "configured": false, "reason": "未配置" } }
```

`apiKeySet` 是"已配置"的权威标记 —— 前端据此显示占位提示，**不自己判断**。

### `POST /api/config`

```json
{ "llm": { "baseUrl": "https://…/v1", "apiKey": "sk-…", "model": "…" },
  "embedding": { "baseUrl": "https://…/v1", "apiKey": "sk-…", "model": "…" } }
```

- **密钥留空或回传打码值 = 保持不变**（不会把已存密钥冲掉），所以表单可以整体原样提交
- 非白名单字段被忽略，非 `llm`/`embedding` 的配置节返回 400（端口等不允许从 HTTP 改）
- 返回体与 `GET` 相同（保存后的打码视图 + 重建后的客户端自描述）

---

## 8. 立场层 `/api/stances`

关系 = 可演化的相对立场。有向不对称：`A→B` 与 `B→A` 是两条记录。多态：`person`/`org` 互指。

### `POST /api/stances` — 手动写入

```json
{
  "holderType": "person", "holderId": 1,
  "targetType": "org", "targetId": 1,
  "stanceType": "敌对", "intensity": 0.9,
  "displayedType": "戒备",        // 表里如一填 null
  "isPublic": false, "targetAware": false,
  "basis": "银手悬赏她的族人",
  "chatId": "chat001", "importance": 0.8
}
```

holder 与 target 同实体 → 400。

### `GET /api/stances?holderType=person&holderId=1[&chatId=][&includeHistory=1][&overview=1]`

默认当前生效；`overview=1` 时每条附 `target_name`（画像/展示用）。

### `DELETE /api/stances/:id` → 软删。

### `POST /api/extract-stances` — 立场抽取管线

```json
{ "chatId": "chat001", "text": "<对话原文>", "sourceMessageIds": ["m50"] }
```

```json
{ "ok": true, "skipped": 0, "stances": [
  { "id": 2, "holder": { "type": "person", "name": "艾拉" },
    "target": { "type": "org", "name": "银手佣兵团" },
    "stanceType": "敌对", "intensity": 0.9, "operation": "create", "supersedes": null }
]}
```

**V7 槽位口径（指针语义）**：槽位 = `(holder, target, dimension)`，写入按三种结构操作处理:

| operation | 条件 | 存储行为 |
|---|---|---|
| `create` | 槽位原本为空 | 写一行（唯一写文本处） |
| `confirm` | 槽位当前值与新值**相同** | **不新增行**，只更新幅度并 `confirms + 1` |
| `migrate` | 槽位当前值与新值**不同** | 写一行并让它的 `supersedes` 指向槽位当前行（指针移动） |

`supersedes` 即前驱行 id（`confirm` 时就是被确认的那一行）。自指立场跳过计数。
**需要并存的两种态度面用不同 `dimension` 声明**（如 `"dimension": "动机"`）——
同维度的值变化是迁移，不是并存。

---

### `POST /api/observe` — 组合抽取（**harness / agent 主入口**）

默认**一次 LLM 调用**产出三层：**事件要素 → 属性观察 → 关系立场**（层的 id/顺序/依赖由
`OBSERVE_PIPELINE` 声明，经 `meta.observePipeline` 下发）。

**为什么要它**（两层理由，第二层才是关键）：

1. 三层必须吃**同一段文本**与**同一组来源楼层**，否则事件/属性/立场描述的不是同一段剧情。
   单步端点分开调时这条不变式只靠调用方纪律维持；组合入口把它收回服务端，调用方无从传错。
2. **跨层锚点只有合并才能填**。分开抽时属性步/立场步看不到事件步刚抽出的实例，
   于是 `valid_from_event_id`（这条观察/立场是被哪个事件触发的）在自动路径上**永远为空**。
   合并成一次阅读后，模型可以在同一份输出里用 `event: "<实例 label>"` 引用自己刚抽的实例，
   服务端据此把锚点填上。响应里的 `anchored` 就是命中计数。

```json
{ "chatId": "chat001", "text": "<剧情原文>", "sourceMessageIds": ["m30","m31"],
  "characterName": "塞拉菲娜", "userName": "林", "writeMemory": true,
  "steps": ["attributes"], "mode": "merged" }
```

| 参数 | 说明 |
|---|---|
| `steps` | 只补跑指定层（会**退化为 split**：合并输出无法只产出一层）。缺省跑全部 = 一次调用 |
| `mode` | `merged`（默认，一次调用） / `split`（三层并行各一次，供对照实验与降级） |

```json
{
  "ok": true, "chatId": "chat001", "mode": "merged", "llmCalls": 1,
  "stepsRun": ["instances","attributes","stances"], "partial": false,
  "zones": { "people": 3, "locations": 2, "instances": 4, "links": 0, "observations": 2, "stances": 1 },
  "missingZones": [],
  "anchored": { "observations": 2, "stances": 1 },
  "steps": {
    "instances":  { "ok": true, "people": [], "locations": [], "instances": [], "links": [], "memoryIds": [] },
    "attributes": { "ok": true, "chunks": [], "skipped": 0 },
    "stances":    { "ok": true, "stances": [], "skipped": 0 }
  }
}
```

**降级口径**（顶层 `ok: true` 不代表三层都成，判读要看 `mode` / `steps` / `missingZones`）：

| 情况 | 表现 |
|---|---|
| LLM 未配置 | **400**（needsLlm=true，与其他抽取端点同口径） |
| embedding 未配置/不可用 | `steps.attributes = { ok:false, skipped:true, skippedReason }`；合并 prompt 会**要求不输出该层**（省输出 token），其余层照常 |
| 模型输出里缺了某分区键 | `missingZones` 如实点名（截断与"确实没有该层内容"在数据上同形，**不猜原因**）；用 `steps` 补跑该层即可 |
| 合并输出**整份解析失败** | 自动降级为 `mode: "split-fallback"`（三层并行），数据不丢；`mergedError` 带原因 |
| 单层失败 | 该层 `{ ok:false, error }`，**不中断**其余层，HTTP 仍 200 |

三个单步端点（`/api/extract`、`/api/extract-attributes`、`/api/extract-stances`）全部保留：
调试用，以及只补跑其中一层。**它们不再是 agent 的入口** —— MCP 只暴露 `memory_observe`。

**重跑是安全的**（每轮编织的前提，V9 起）：同一窗口重抽 = 重述，事件不新增行只 `confirms+1`；
属性层按规范化文本判等；立场层走槽位指针。**但 `sourceMessageIds` 必须忠实反映该窗口**——
它是事件判等键的一半。

---

## 8.1 槽位与状态迁移 `GET /api/slots`（V7 立场 / V8 属性，只读）

迁移记录**从 supersedes 链推导，不建表**：链头 = 当前指针值，沿指针回溯的相邻两行值不同即为一次迁移。
"值动没动"的判据：立场比字符串；属性比规范化指纹（`meta.slotModel.restatement.normalize`）。

```json
{ "ok": true,
  "slots": [ { "key": "person:1>person:2@总体", "kind": "stance", "dimension": "总体",
               "value": "信任", "confirms": 1, "stanceId": 3,
               "transitions": [
                 { "operation": "create", "value": "戒备", "at": 1700000000 },
                 { "operation": "confirm", "value": "戒备", "at": 1700000100, "count": 1 },
                 { "operation": "migrate", "from": "戒备", "value": "信任", "at": 1700000200 } ],
               "legacyCoexist": [] } ],
  "attributeSlots": [ { "key": "person:1@habit", "kind": "attribute",
               "entityType": "person", "entityId": 1, "entityName": "艾拉", "aspect": "habit",
               "value": "每次进门都先嘲讽一句", "confirms": 2, "observations": 5,
               "chains": [ { "chunkId": 9, "content": "...", "importance": 0.7,
                             "confirms": 2, "observations": 5, "supersedeSimilarity": 0.9037,
                             "transitions": [ { "operation": "create", "value": "...", "at": 0 },
                                              { "operation": "confirm", "count": 2, "at": 0 },
                                              { "operation": "migrate", "from": "...", "value": "...", "at": 0 } ] } ] } ],
  "transitions": [ { "operation": "migrate", "from": "戒备", "value": "信任", "at": 1700000200 } ],
  "attributeTransitions": [ { "operation": "migrate", "from": "...", "value": "...", "slotKey": "person:1@habit" } ],
  "counts": { "create": 1, "migrate": 1, "confirm": 1, "revoke": 0 },
  "attributeCounts": { "create": 1, "migrate": 2, "confirm": 2, "revoke": 0 },
  "labels": { "create": "建立", "migrate": "迁移", "confirm": "确认", "revoke": "撤销" },
  "slotDefs": [ { "kind": "stance", "label": "立场槽", "key": "(持有者, 对象, 维度)" },
                { "kind": "attribute", "label": "属性槽", "key": "(实体, 维度)" } ],
  "restatement": { "rule": "normalize-equal", "normalize": "...", "semantics": "...",
                   "whyNotThreshold": "...", "keepDetail": "..." } }
```

- `legacyCoexist`：V6 及以前遗留的同槽位并存行（旧规则允许不同 `stance_type` 并存），**只标注不改数据**。
- **属性槽可多元并存**（V8）：相似度不足就不进同一条链 —— 同一 `(实体, 维度)` 槽位下多条 `chains` 是
  正常的多元观察，不是遗留数据；槽位的 `value`/`confirms` 取 importance 最高的那条链头。
- **`observations` 与注入 ×N 同口径**：链上 Σ(1 + confirms) = 这条属性被观察到的总次数
  （旧行 confirms=0 时恰好等于旧链深，零漂移）。
- **撤销（软删）不做自动回退**：撤销迁移行后该槽位即"没有当前值"，前驱不会复活（被覆盖集合从全表算）。
- 同一份口径也出现在注入里：【关系立场】表的「立场」列显示 `戒备 → 信任`（`meta.injectionTables.stanceDisplay`）；
  关键实体表的 ×N = 总观察次数。

---

## 9. 遗忘任务 `/api/forget`

衰减分：`score = 0.5·importance + 0.3·时间新近度 + 0.2·访问频率`（stances 无访问追踪，按 0.6/0.4 重归一）。半衰期 30 天。
保护：`importance ≥ 0.9`、入库不足 30 天，不入选。

### `POST /api/forget`

```json
{ "threshold": 0.25, "minAgeDays": 30, "protectImportance": 0.9, "confirm": false }
```

**`confirm` 缺省/false = dry-run**，只返回候选不改动；`true` 才执行软遗忘（事务）：

```json
{ "ok": true, "dryRun": true, "candidateCount": 3, "forgotten": [], "forgottenCount": 0,
  "candidates": [ { "table": "memories", "label": "记忆", "id": 4, "score": 0.08,
                    "ageDays": 102, "importance": 0.1, "accessCount": 0 } ] }
```

### `POST /api/forget/restore`

```json
{ "table": "memories", "id": 4 }    // table ∈ memories | attribute_chunks | stances
```

---

## 10. 前端插件推荐调用时序

```
每轮生成前:
  POST /api/context        { query: 最近用户输入, chatId, characterId }  → text 拼进 prompt

每 N 层(或手动触发)写记忆:
  POST /api/extract              述谓实例 (谁—动词—谁 + 来源/时态, V6 起)
  POST /api/extract-attributes   属性观察 (角色细节)
  POST /api/extract-stances      立场演化 (关系变化; 槽位模型: 值变了才是迁移)
  ↑ 三个端点互相独立, 可并行, 共用同一段对话原文

槽位与迁移 (V7, 只读):
  GET  /api/slots?chatId=        当前指针值 + 迁移序列 (从 supersedes 链推导)
  GET  /api/config               模型配置打码视图 (密钥 ••••+末4位)
  POST /api/config               保存模型配置 (深合并写盘 + 热重建, 密钥留空=保持不变)

画像更新(抽取了属性块之后, 或手动):
  POST /api/profiles-derive { personId, characterId }

定期维护(每天/每 session):
  POST /api/forget {}            先看候选
  POST /api/forget {confirm:true} 确认后执行
```

**chatId 建议**：用酒馆的 chat 文件名（去扩展名）；**characterId**：用角色卡名字符串（与 `character_id` 列一致，非 people 表 id，注意区分——profiles 用角色卡名，chunks/stances 用 people/orgs 表整数 id）。

**错误处理**：
- 未配置真实 LLM（`provider: openai-compatible` 但 key/model 为空）时，四个抽取端点返回 400：
  `{"ok": false, "error": "llm 未配置完整 (baseUrl/apiKey/model), 请编辑 server/config.json"}`
- 未配置 embedding 时，`/api/extract-attributes` 返回 400 同类文案；`/api/retrieve`、`/api/context`、`POST /api/chunks` 则**静默降级**（分别无 `chunkHits` / 无细节段 / `embedded: false`），不影响主流程
- 建议前端对抽取类失败静默降级：只跳过写入，绝不影响 `/api/context` 的注入

**能力依赖矩阵**（决定哪些端点必须配什么才能用）：

| 端点 | 需要 LLM | 需要 embedding |
|---|---|---|
| `/api/extract` | ✅ 必须 | — |
| `/api/extract-attributes` | ✅ 必须 | ✅ 必须 |
| `/api/profiles-derive` | ✅（仅当该人物已有生效观察块时才真正调用） | — |
| `/api/extract-stances` | ✅ 必须 | — |
| `/api/chunks` (POST) | — | 可选（缺则 `embedded:false`，不参与向量召回） |
| `/api/retrieve` `/api/context` | — | 可选（缺则只用 FTS + 画像） |
| 其余端点 | — | — |

---

## 11. 已知限制（前端需知的边界）

1. **`config.retrieval.topK / tokenBudget`** 是 `/api/retrieve`、`/api/context` 的默认值来源（请求体传了则以请求体为准），不是硬编码——改配置后重启生效。
2. **`GET /api/memories` 不传 `chatId`/`characterId` 时**，可见性条件退化为"仅 `scope='global'`"，不会返回 chat/character 级记忆。
3. **`PATCH /api/memories/:id` 不能改** `type` / `scope` / `characterId` / `chatId`（写入后不可迁移；需要改就新建 + 软删旧的）。
4. **三阶属性观察只支持 `person` / `location`** 实体，`item` / `org` 的观察会被跳过并计入 `skipped`（表结构已支持，抽取器未开）。立场层则支持 `person` / `org` 互指。
5. **`entities` id 体系有两套**：`character_profiles.character_id` 是**字符串**（角色卡名），`attribute_chunks.entity_id` / `stances.holder_id` 是 **people/orgs 表的整数 id**。前端两套别混用。
6. **向量召回为内存暴力余弦**（加载全部当前生效块），块数 <10k 时毫秒级；超量需切 sqlite-vec（接口不变，数据不动）。
7. 默认**无鉴权**且仅监听 `127.0.0.1`（回环 = 信任）。离开回环前**必须**设 `server.token` 启用令牌鉴权；令牌是可撤销的访问凭据，上游 API key 永远只在服务端。见 README「手机 / 局域网访问」。
8. **`/api/profiles-derive` 在目标人物无生效观察块时会短路**，直接返回 `{ ok: true, entries: [], chunkCount: 0 }`，**不会触达 LLM**（因此此时即便 LLM 未配置也返回 200 而非 400）。前端别把"空 entries"当成功归纳，需先确认该 personId 已有 `attribute_chunks`。**注意短路判定发生在"LLM 客户端已注入"之后**：若 `llm` 完全不注入（服务端装配问题），仍会先返回 400 `LLM 客户端未初始化`。
9. **静默降级的触发条件是"embedding 不可用"，不只是"embed 客户端为 null"** —— 客户端存在但 `baseUrl/apiKey/model` 未配全时同样算不可用。`/api/context`、`/api/retrieve`、`POST /api/chunks` 三种情况都静默降级，不会因为 embedding 未配置而报错。此点由 `test/meta.smoke.js` 针对"客户端在但未配置"这一格独立钉死（`embed === null` 与"存在但未配置"是两条不同分支，前者曾漏测）。
10. **`/api/meta` 的 `defaults.retrieval` 是生效值**（受 `config.retrieval` 影响），不是示例值；改配置后重启生效。

---

## 12. 契约描述 `GET /api/meta` —— 前后端唯一语义源

前端插件**不得**内置本服务的枚举与标签、打分权重与公式、阈值、生效默认值、能力判断逻辑、错误文案。
这些一律运行时从本端点取得。服务端内部同样只从 `server/src/domain/constants.js` 派生，
因此「前端展示的语义」与「后端实际执行的语义」是同一份数据，不会漂移。

```bash
curl http://127.0.0.1:7780/api/meta
```

### 12.1 响应结构

| 字段 | 说明 |
|---|---|
| `service` `version` `schemaVersion` `latestSupported` | 服务标识与 schema 版本 |
| `generatedAt` | 生成时间（Unix 秒） |
| `capabilities` | 运行时能力：`llm` / `embedding` / `vectorSearch` / `storage` |
| `defaults` | **生效**默认值：`retrieval`（受 config 影响）/ `memory` / `chunk` / `stance` / `forget` / `summary` |
| `enums` | 枚举与标签，每项 `{ constrained, options:[{value,label,...}], note }` |
| `scoring` | 打分口径：`retrieval` / `forget` / `tokenEstimation`，含 `formula` 原文 |
| `summaryPolicy` | 长对话压缩策略：**触发楼层数**/单批安全阀/摘要长度上限/建议保留楼层数/**前情提要段配置 `digest`**/理由/节奏预设/合法区间 |
| `thresholds` | `supersedeSimilarity` / `similarityMetric` |
| `contextSections` | 注入文本的段落顺序（当前时间 → 角色画像 → 关系立场 → 关键实体 → 前情提要 → 事件时间线 → 待兑现 → 相关记忆 → 相关细节） |
| `digestFormat` | 【前情提要】的段落形状：`header` 与每行模板 `line`（前端只展示、不解析） |
| `rules` | 生效规则文案：可见性、当前生效口径、软删除、supersede、立场演化、两套 id 体系… |
| `endpoints` | 端点清单，含 `needsLlm` / `needsEmbedding` / `degrade` / `degradeNote` |
| `limits` | `auth` / `jsonBodyLimit` / `boundTo` 与安全提示 |
| `cors` | 实际生效的 CORS 策略 |

### 12.2 capabilities

```json
{
  "llm":       { "name": "llm", "available": true, "configured": true, "provider": "openai-compatible",
                 "model": "gpt-4o-mini", "timeoutMs": 60000, "reason": null },
  "embedding": { "name": "embedding", "available": true, "configured": true, "provider": "openai-compatible",
                 "model": "bge-m3", "dim": null, "timeoutMs": 60000, "batchSize": 32, "reason": null },
  "vectorSearch": { "available": true, "metric": "cosine", "strategy": "in-memory-brute-force",
                     "approximate": false, "reason": null },
  "storage": { "kind": "sqlite", "fts": "FTS5", "softDelete": true }
}
```

- `available=false` 时 `reason` 一定非空。前端应据此禁用相关按钮并**原样展示**该原因。
- `timeoutMs` 供前端推算自身 fetch 超时（应大于服务端超时并留余量），前端不必写死数字。
- `vectorSearch.available` 跟随 `embedding.available`；为 false 时第三路召回整体关闭。

### 12.3 enums

每项统一为 `{ constrained, options, note }`：

- `constrained: true` —— 后端会校验，前端应用下拉框
- `constrained: false` —— 后端不校验，`options` 仅作输入建议（可用可输入的下拉）

| 键 | constrained | 说明 |
|---|---|---|
| `memoryType` | 是 | fact / event / summary，带中文 label 与 description |
| `memoryScope` | 是 | character / chat / global，带 description |
| `entityType` | 否 | person / location / item / org，仅建议 |
| `chunkableEntityType` | 是 | **只有 person / location**，三阶抽取器不支持 item/org（见 §11.4） |
| `stanceEntityType` | 是 | person / org 可互指 |
| `aspect` | 否 | 结构为 `byEntityType: { person: [...], location: [...] }`，非 options |
| `stanceType` | 否 | 常见立场类型，抽取器按语义自由生成 |
| `forgetTable` | 是 | 每项带 `hasAccess`，标明该表是否有访问追踪 |
| `slotOperation` | 是 | 槽位值的结构操作 create / migrate / confirm / revoke（V8）；抽取结果分类与 `/api/slots` 都用这套标签 |

### 12.4 endpoints

前端**不要**自己判断“有没有配 LLM”，直接读这里的声明：

```json
{ "method": "POST", "path": "/api/context",
  "summary": "注入组装, 前端每轮生成前的主入口",
  "needsLlm": false, "needsEmbedding": false,
  "degrade": "silent",
  "degradeNote": "未配 embedding 时无【相关细节】段, 仍返回画像与 FTS 记忆" }
```

可用性判定公式（前端照此实现即可，不要另写判断）：

```
可用 = ( !needsLlm       || capabilities.llm.available )
   &&  ( !needsEmbedding || capabilities.embedding.available )
```

`degrade` 描述依赖缺失时的行为：`silent` = 静默降级（仍 200），`error` = 返回 400。

### 12.5 scoring / thresholds / rules

供前端**原样展示**，不要在前端重写一套说法：

```json
"scoring": {
  "retrieval": {
    "weights": { "relevance": 0.6, "importance": 0.25, "recency": 0.15 },
    "formula": "score = 0.6 × 相关性 + 0.25 × importance + 0.15 × 时间新近度",
    "recencyHalfLifeDays": 30,
    "recencyFormula": "recency = exp(-ageDays × ln2 / 30), ageDays 从 last_accessed_at(无则 created_at) 起算",
    "relevanceFormula": "FTS: bm25 归一到 [0,1]; 向量: 余弦相似度归一到 [0,1]"
  },
  "forget": {
    "weights": { "importance": 0.5, "recency": 0.3, "frequency": 0.2 },
    "formula": "score = 0.5 × importance + 0.3 × 时间新近度 + 0.2 × 访问频率",
    "noAccessWeights": { "importance": 0.6, "recency": 0.4 },
    "noAccessFormula": "score = 0.6 × importance + 0.4 × 时间新近度",
    "halfLifeDays": 30, "frequencySaturation": 10,
    "protections": [ "importance ≥ protectImportance 的条目不入选", "入库不足 minAgeDays 天的条目不入选" ],
    "tables": [ { "value": "stances", "label": "立场", "hasAccess": false } ]
  },
  "tokenEstimation": { "formula": "估算 token ≈ ⌈字符数 / 2⌉", "description": "中英混合的保守估算, 不是真实分词" }
},
"thresholds": { "supersedeSimilarity": 0.85, "similarityMetric": "cosine" }
```

### 12.6 一致性约定（前后端必须遵守）

1. 服务端内部一切跨端可见的常量**只在** `server/src/domain/constants.js` 定义一次，本端点从中派生；禁止在 service 层重复字面量。
2. 前端不得另存一份枚举 / 默认值 / 公式 / 错误文案。契约未载入（连不上服务）时应显示“未载入”并**禁用**依赖项，**不得**退回本地硬编码。
3. `defaults.retrieval` 报告的是**生效值**，不是文档示例。
4. 以上第 1、2 条由自动化测试钉死：
   - `server/test/meta.smoke.js`：枚举与常量同源、每个声明端点真实存在、`needsLlm/needsEmbedding` 标记与实测行为一致、声明 `degrade=silent` 的端点在“embedding 客户端存在但未配置”时确实不报错、CORS 放行与拒绝行为。
   - 仓库根目录的 `check-contract.mjs`（即扩展自带的前端检查脚本）：用前端自己的 `api.js`/`meta.js` 对接真实服务，校验 `canCall` 与声明逐条一致、标签取自服务端、超时由服务端推算、服务不可达时一律不可用。

---

## 13. 长对话压缩 `POST /api/summarize`

把一段剧情压成**一条摘要记忆**（`memories.type = 'summary'`）。

摘要**不是**另存一份结构 —— 它就是普通的一阶记忆，因此可见性（`scope`/`chat_id`）、软删除、FTS 检索、遗忘衰减全部沿用同一套规则。

> **但注入时它不参与相似度打分。** 摘要覆盖的正文会被 `/hide` 移出 prompt，摘要是那段剧情唯一的载体；若按 FTS 取 top-k，当前轮关键词不命中就整段丢失（而且摘要长、关键词稀疏，在 bm25 里天然吃亏）。所以注入时摘要被**排除出相似度召回**，改由【前情提要】段按楼层顺序常驻 —— 见 §5 与 [summarization.md](./summarization.md) 第 5 节。

> **何时调用由前端决定。** 服务端只负责"给一段文本，还一条摘要"。触发楼层数、单批安全阀、摘要长度上限都在 `GET /api/meta` 的 `summaryPolicy` 里下发，前端不另存一份。取值依据与调参建议见 [summarization.md](./summarization.md)。

### 请求

| 字段 | 必填 | 说明 |
|---|---|---|
| `chatId` | 是 | 摘要以 `scope='chat'` 写入该会话 |
| `text` | 是 | 待压缩的对话原文（前端拼好，形如逐行 `角色名: 内容`） |
| `sourceMessageIds` | | 覆盖的楼层号数组，用于溯源与**去重** |
| `characterId` | | 仅作上下文记录，不改变落库作用域 |
| `inWorldTime` | | 剧情内时间标签 |
| `keywords` | | 调用方补充的关键词，与模型产出的关键词合并 |
| `importance` | | 缺省取 `summaryPolicy.defaultImportance` |
| `maxChars` | | 摘要正文上限，会被**钳制**到 `summaryPolicy.maxSummaryChars`（调用方无法突破） |
| `dedupe` | | 默认 `true`：同一聊天内覆盖楼层集合完全相同时复用既有摘要 |

```bash
curl -X POST http://127.0.0.1:7780/api/summarize \
  -H 'Content-Type: application/json' \
  -d '{"chatId":"c1","text":"主角: 你还记得那个雨夜吗\n艾拉: 记得。","sourceMessageIds":["0","1"]}'
```

### 响应

```json
{
  "ok": true,
  "deduped": false,
  "memoryId": 41,
  "memory": {
    "id": 41, "type": "summary", "scope": "chat", "chatId": "c1",
    "content": "暴雨夜主角躲进夜莺酒馆…",
    "keywords": "艾拉 夜莺酒馆 结伴",
    "importance": 0.6, "sourceMessageIds": ["0", "1"],
    "tags": ["summary"], "inWorldTime": null, "createdAt": 1791234567
  },
  "coveredMessageIds": ["0", "1"],
  "keyPoints": ["与艾拉在酒馆初遇", "约定次日结伴出城"],
  "truncated": false,
  "inputChars": 812
}
```

- `deduped: true` 时 `memoryId` 是既有摘要的 id，`keyPoints` 为空数组（**没有**重新调用 LLM）—— 手工连点两次"立即总结"不会产生两条一样的摘要。
- `truncated: true` 表示模型输出超长、已按上限截断并以 `…` 收尾。
- 缺 `chatId` / 空 `text` 返回 400；LLM 未配置返回 400 `"LLM 客户端未初始化"`（与 `needsLlm: true` 声明一致）。

### `summaryPolicy`（`/api/meta` 下发）

```json
{
  "triggerFloors": 10,
  "maxBatchTokens": 12000,
  "maxSummaryChars": 800,
  "defaultImportance": 0.6,
  "keepRecentMessages": 6,
  "trigger": "floor-count",
  "digest": {
    "maxTokens": 2000,
    "scope": "chat",
    "limits": { "min": 1, "max": 8000 },
    "rationale": "…为什么预算不足时保新丢旧…"
  },
  "rationale": "…为什么按楼层而不是按 token 触发…",
  "presets": [{ "floors": 10, "note": "默认量级, 大致一小场戏" }],
  "limits": { "min": 2, "max": 200 }
}
```

**触发量纲是楼层数**（`trigger: "floor-count"`）：`triggerFloors` 指未总结区间的**聊天记录条数**（用户与角色各占一层，即酒馆里"第几楼"），达到该值就触发一次总结。之所以不用 token：单条输出的长短因人而异，固定 token 阈值等于把"什么时候会总结"交给了用户的语速，话密的人三五层就触发、话少的人几十层才触发，用户无从预期。楼层数则是用户能直接看到的量。

⚠️ `maxBatchTokens` **不参与触发判断** —— 它只是"单批送进 LLM 的输入安全阀"（楼层数与文本量不成正比）。前端拿它算单批字符上限；触发的判断入口只有 `triggerFloors`。

`scoring.tokenEstimation.charsPerToken` 是前端做模糊估算用的系数 —— **前端按它算，不写死 2**；`formula` 文本里的数字由同一个常量生成，不会出现"公式说 2、参数写 3"的分裂。它现在只服务两件事：注入预算、单批安全阀。

`summaryPolicy.digest` 是【前情提要】段的配置：`maxTokens` 为该段的独立预算（前端"前情提要预算"输入框填 0 即用它），`scope` 固定为 `chat`（只拼本聊天的摘要链）。
