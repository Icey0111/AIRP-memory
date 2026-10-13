# 注入表格化设计 —— 把数据库映射为多维度层级交联的表格系统

> 状态: 设计稿 (待实现) · 版本: T0 草案 · 日期: 2026-10-13
> 前置约束: **结构层冻结** (schema_version=5, 不新增表/列) · 语义同源铁律 (constants.js 唯一定义, /api/meta 下发, 前端不硬编码)

---

## 1. 目标与非目标

**目标**: 把注入文本从"平铺 bullet 行"升级为结构化表格系统，让 LLM 对关系型信息（谁对谁什么态度、事件间因果、参与者）的组织与推理更强。

**非目标**:
- 不做全库 dump —— 预算会爆，仍然沿用"常驻 + 检索 top-k"两条通道，表格只是**行的组织方式**；
- 不改结构层 —— 全部数据已在库中（六要素 / 画像 / 观察块 / 立场），本设计是纯**渲染层**；
- 不改酒馆侧注入机制 —— 仍是 `setExtensionPrompt('tavernMemory', ...)` 注入一段文本，表格是文本形状，不是 UI。

## 2. 技术选型：服务端 TypeScript 渲染器

| 决策 | 结论 | 依据 |
|---|---|---|
| 渲染器语言 | **TypeScript** (`server/src/services/tableRender.ts`) | Node 22.22 原生 type stripping，`.ts` 直接运行、零构建（已实测，`.js` 里 `import './x.ts'` 也可）；列定义/单元格类型获得编译期约束 |
| TS 语法约束 | 仅可擦除语法 | `interface` / `type` / 泛型 / 注解可用；`enum`、`namespace`、参数属性、装饰器**不可用**（需 transform 才行，不引入） |
| import 规则 | 相对导入必须写全 `.ts` 扩展名 | 原生 type stripping 不做扩展名推断 |
| 前端 | 保持 `.js` 不动 | 酒馆扩展是浏览器直接加载 ESM，无构建管线；浏览器跑不了 `.ts`。渲染器本来就该在服务端——**检索预览里看到的与实际注入的是同一份字节** |

**格式整齐的实现口径**（TS 本身不产生整齐，整齐来自这三件事）:
1. **CJK 感知对齐**：中文字符显示宽按 2 列计，`padEnd` 按码点数对齐必然错位；列宽一律按显示宽度（`East Asian Width` 口径的简化实现）计算；
2. **列定义类型化**：每张表是一个 `TableSpec`（列 key / 标题 / 显示宽度权重 / 截断策略），编译期约束"漏填单元格""列名漂移"；
3. **快照测试钉死**：`test/tables.smoke.js` 对每种表格的渲染输出做精确断言，格式被意外改动时测试立即红。

## 3. 注入段结构（升级后）

两个层级、七个段落。常驻段必然在场、不参与相似度打分（沿用现有设计哲学）；检索段按打分填预算。

| # | 段落 | 层级 | 数据来源 | 状态 |
|---|------|------|----------|------|
| 1 | 【角色画像】 | 常驻 | `character_profiles` | 已有 → 表格化 |
| 2 | 【关系立场】 | 常驻 | `stances`（当前生效口径） | **新增段** → 表格化 |
| 3 | 【关键实体】 | 常驻 | people/locations/items/orgs + 生效观察块 | **新增段** → 表格化（高压缩交联的静态信息住处，见 §4.2） |
| 4 | 【前情提要】 | 常驻 | summary 类 memories | 已有 → **保持不变**（楼层区间行不是表格语义） |
| 5 | 【事件时间线】 | 常驻限量 | `events` + `event_participants` + `event_links` + `time_points` | **新增段** → 表格化（时间节点锚定，见 §3.4） |
| 6 | 【相关记忆】 | 检索 | FTS 召回 memories | 已有 → 行化 |
| 7 | 【相关细节】 | 检索 | 向量召回 attribute_chunks | 已有 → 行化 |

### 3.1 【角色画像】表（常驻 ✅ T1 已实现）

```
【角色画像】
类别         条目      内容
-----------  --------  ------------------------------
appearance   发色      银白, 及腰
personality  危机反应  嘴上嘲讽, 但会下意识挡在前面 ※
             说话风格  冷淡克制, 句子短
```

- 按 `category` 分组渲染（`getProfile` 已按 category, key 排序），**同类别只在首行出现一次**（分组锚点留空）；
- 每行溯源：`derived_from_chunk_ids` 非空的条目行尾加 `※`（表示"由观察块归纳，非人工设定"），供人工核对，不解释语义；
- **跨段去重（L3③，已实现）**：立场表非空时，`category = relationship` 且正文含立场对端名的条目**不再注入**——立场表带强度/表露/依据，信息更全，画像里再写一遍只是重复占 token。开关 `INJECTION_TABLES.dedupe.profileStanceOverlap`。
  - 这是**呈现层**特性：关掉表格化（`injectTables:false`）或关掉去重开关时，那条画像会照旧出现 —— 回退路径的口径与"表格化之前"完全一致，且数据一字未删（实测确认）。

### 3.2 【关系立场】表（常驻，新增段 ✅ T1 已实现）

```
【关系立场】
持方  对方      立场  强度  表露                    依据
----  --------  ----  ----  ----------------------  ----------------
艾拉  主角      戒备  中    隐秘·表面友好·对方不知  曾被撞见翻查卷宗
      档案商会  利用  高    即本心                  ——
主角  艾拉      信任  低    即本心                  ——
```

- 查询口径 = 当前生效立场（`is_active=1` + 未过 `valid_to` 区间 + 未被 supersedes），`chat_id` 匹配当前聊天；
- 两端名字都解析（`people` / `orgs` 多态）——**不裸 id**，名字才能和画像/时间线/细节段互相呼应；
- **二阶语义压缩进"表露"列**：`displayed_type` 非空 → `表面{displayed_type}`，否则 `即本心`；`is_public=0` → 前缀 `隐秘·`；`target_aware=0` → 后缀 `·对方不知`。一列承载三个布尔维度的交联，不爆列数；
- `basis` 为空显示 `——`（占位保对齐）；
- 强度列显示三档（低/中/高，0.34 / 0.67 分界），避免 0.57 这种噪声数字；
- **排序**：先按 importance 降序取前 `stanceRows` 条（规模防线），再按持方归拢——持方之间的先后 = 该持方**最高 importance 降序**（关系越重越靠前），组内再按 importance 降序；这样"持方"列每组只出现一次且主线关系排最前。

### 3.3 【前情提要】（不变）

沿用 `DIGEST_FORMAT`：`[{from}-{to}] {content}` 楼层区间行。它是时间序列不是实体表格，强行表格化只增加 token 无信息增益。

### 3.4 【事件时间线】表（常驻限量，新增段，交联核心）

**时间不是普通属性列，而是网络节点**：它为动态事件提供因果先后的锚定骨架。因此时间线按"时间节点 → 挂载事件"两级结构渲染——同一时间节点只出现一次，多个事件挂在它下面；事件之间的因果边相对这个骨架标注。

```
【事件时间线】
时间节点           事件        参与者        地点    因果标注
-----------------  ----------  ------------  ------  --------------------
第三夜, 暴雨 #7   酒馆初遇    主角, 艾拉    酒馆    ← 起因: 主角避雨
                   卷宗失窃    艾拉          档案馆  → 引出: 两人对质
第四日 #8          两人对质    艾拉, 主角    档案馆  ⇠ 前承: 卷宗失窃
```

- **时间节点 = 行分组锚点**：`label + seq`（seq 是同一聊天内时间线的先后序号，节点首现行尾标 `#7` 即锚点编号）；一个节点下的多个事件共用一次时间描述，事件行不再各自复述时间——这是时间维度上的 L1 归一（见 §4.1）；
- **层级**：`time_points.parent_id` 支持嵌套（某夜属于某章）；父节点仅在切换时渲染一行小标题（`── 第三章 ──`），不逐行重复；
- **因果标注三类**（`event_links` 的三个方向压成一列）：`← 起因: {事件标题}`（caused 入边）/ `→ 引出: {事件标题}`（led_to 出边）/ `⇠ 前承: {事件标题}`（preceded 边，因果链的时间补全）。标题与时间线内其他行呼应，构成事件-事件交联；
- **事件注记**（用户图示确认）：事件名后可带短注记 `〔抉择: …〕`，来源 = `events.process / cause_text / result_text` 的压缩 + `event_participants.role`（谁发起/谁决定）——behavior/decision 类语义全在既有自由文本列里，**零表变更**；注记内容**只写事件独有信息（行为/抉择/转折）**，禁止复述时间/参与者/地点（§4.6 信息正交性，列里已有，复述即冗余）；
- **参与者/地点列是实体名字引用**（不裸 id，LLM 读不懂整数），并适用 §4.2 的首现展开规则；参与者带 role 压缩：非"参与者"角色写成 `艾拉(发起者)`；
- 取当前聊天 `seq` 最近的 N 个事件（默认 12），按 `(time.seq, event.id)` 排序；同一节点内多事件按 id 即叙事顺序；
- 实现：四表 join（events × event_participants × event_links × time_points/locations），一个只读查询函数（**只读，不动表**）。
- **实现口径（T2 落地时确定）**：行分组**按 `time_id` 判等、不按渲染文本**——章节前缀会让首行与后续行的文本不同，文本比对会漏掉该留空的行；因果边每条只渲染一次，渲染在"它是谁的成因/前承"那一行：`caused` 取**入边**、`led_to` 取**出边**、`preceded` 取**入边**、`contradicts` 双向各标一次；对端事件在窗口外时只取标题（跨窗口的因果线不断）；无 `time_id` 的事件排在最后，锚点用占位符。

### 3.5 【相关记忆】行化（检索层）

```
【相关记忆】
| 类型 | 剧情时间 | 内容 | 楼层 |
| fact | 第三夜 | 主角是左撇子 | 12 |
| event | 第四日 | 档案馆的卷宗不翼而飞 | 18 |
```

- 检索层用**紧凑 markdown 管道行**（不对齐、无分隔行），省 token——检索行数量多且每轮变化，对齐开销不值；
- "楼层"列来自 `source_message_ids` 首个值，让模型能把记忆锚回对话位置。

### 3.6 【相关细节】行化（检索层）

```
【相关细节】
| 实体 | 维度 | 观察 |
| 艾拉 | personality | 嘴上嘲讽, 但主角遇险时会下意识挡在前面 |
| 酒馆 | atmosphere | 雨夜壁炉的松木味混着劣质麦酒 |
```

- 实体列解析成人名/地名；内容列超长截断（见 §6）；与常驻表重复的观察不重复渲染（§4.1 L3）——**按链头块 id 精确判定**，不比文本：速写为 `×N` 预留宽度后必然被截断，文本比对一定漏。

## 4. 高压缩交联：静态信息的归一与复现（追加设计 2026-10-13）

设计原则: **静态信息只描述一次，之后全部用引用复现**。AIRP 中大量 token 花在"同一人物 / 同一环境 / 同类行为"的反复叙述上——不同时间发生的是相似静态空间的复现。表格化交联的价值正是把这些重复折叠掉: token 大幅下降的同时，"×N 复现计数"反而告诉模型这是**稳定模式而非偶发**，压缩与质量同向。

### 4.1 三级压缩模型

| 层级 | 折叠对象 | 机制 | 落点 |
|---|---|---|---|
| L1 实体归一 | 同一个人/地点/物品/组织/**时间节点** | 全库单一规范行（aliases 归并；时间点 label+seq 全聊天唯一），事件/立场/观察/记忆引用只存整数 id，注入时渲染为**名字引用**；同一时间节点的描述只渲染一次（§3.4 分组锚点） | 结构已支持（people/locations/items/orgs/time_points + 外键引用），零变更 |
| L2 观察折叠 | 同实体同维度的相似静态观察（"每次见面都那副样子"） | 写入期 supersedes 链（sim≥0.85 自动折叠，链头唯一生效）；注入只渲染链头 + **复现计数 ×N**（N=链中被折叠的观察数，链深度只读查询可得） | 结构已支持（attribute_chunks.supersedes_chunk_id），零变更 |
| L3 渲染期去重 | 跨段落/跨行的重复呈现 | ① **首现展开、复现引用**：实体在注入文本中第一次出现带短速写，此后只出现名字；② 检索行与常驻表重复的观察不重复渲染（画像表/实体表已覆盖的内容，检索层只渲染增量）；③ 立场表与画像表重叠的态度条目以立场表为准 | 纯渲染层逻辑，零表变更 |

### 4.2 新增常驻段：【关键实体】表

静态空间的"规范描述"需要住处。画像表只覆盖主角（character_profiles），地点/物品/组织/NPC 的速写目前只能靠向量检索零散命中——这正是重复信息的来源。新增常驻表:

```
【关键实体】
实体    类型    别名          速写（规范描述）
------  ------  ------------  --------------------------------
酒馆    地点    破釜酒吧      雨夜壁炉松木味混劣质麦酒, 二层隔音差
艾拉    人物    小艾, EllA    银发档案员, 嘴上嘲讽遇险护人 ×3
怀表    物品    ——            黄铜怀表, 停在第三夜十一点
```

- **数据口径**: `description` 字段优先；为空取该实体最高 importance 的生效观察块（链头，截断到单元格上限）；两者常是同一句话的不同版本，**互相覆盖时只留一份**（否则拼两遍等于把压缩花回去）；
- **排序口径**: `(被事件引用总度数 + 时间线窗口内度数) × 观察块最高 importance` —— 复现频次本身就是重要度，反复出现的空间自然排前面；窗口内额外加权让"正在发生"的热点再往前；
- **入目录门槛**: 实体必须在**本聊天有存在证据**（被本聊天事件引用过，或被本聊天的观察块看过）。实体的 `description` 是全局字段，若只按"有描述"收录，新开一条聊天会凭空冒出全库所有描述过的角色/地点——实体表是这张图在当前聊天的节点目录，不是全库 dump；
- 度数来源按类型分派：person 走 `event_participants`、location 走 `events.location_id`、item / org 走 `memory_entity_refs`（经 `memories.chat_id` 限定到本聊天）；
- 行数上限 15，独立预算 400 token；
- **与时间线交联**: 事件时间线/立场/记忆行中出现的实体名，若已收录本表 → 纯名字引用；未收录且为首次出现 → 行内就地展开短速写（括号内 ≤12 显示宽）。**同一名实最多一次全量描述**；
- 人物速写带链头复现计数（上例 `×3`）。

### 4.3 复现计数的口径

- 只对**观察块链头**渲染 `×N`——它表达"该行为/特征被反复观察到 N 次"，是行为模式的证据；
- 立场不渲染 ×N（stance 的 supersedes 是"版本演化"不是"重复确认"，语义不同，打了会误导）；
- 事件表中地点的复现不打点——时间线每一行本身就是复现记录，按名引用已是最省表达。
- **实现口径（T2）**: `×N` **先预留宽度再截断正文**——它长在速写末尾，而速写常常超长，若交给单元格上限统一截断，最先被切掉的恰好是这个最有信息量的信号。

### 4.4 质量保底（压缩只吃重复，不吃差异）

- supersedes 阈值 0.85 就是"压缩 vs 质量"的旋钮：**判定相似才折叠**，真正不同的观察永不合并；
- L3 去重只删"呈现"，不删"数据"：被折叠观察的原文一字不删（存取分离原则不变），降阈值或回溯历史随时可恢复；
- `injectTables` 关闭即回到全量 bullet 路径，无损可逆。

### 4.5 图视角对齐（用户图示确认 2026-10-13）

用户以手绘图确认了心智模型：记忆是一张**以事件为枢纽的异质网络**——time / char / user / location / others 为实体节点，event 为动态枢纽节点，节点间多对多交联。这张图就是 V2 六要素模型本身，节点与边全部有落点:

| 图示 | 库中落点 |
|---|---|
| user 节点 | `people`（person_type='main'，抽取 prompt 已固定"用户扮演的主角为 main"——user 永远是一等节点，不从图中缺席） |
| char1 / others | `people`（npc）/ `orgs` |
| time1 / time2 | `time_points`（chat 内 label+seq 锚点） |
| location1 / location2 | `locations`（parent 层级） |
| event1 / event2 | `events`（动态枢纽） |
| event—time / event—location 边 | `events.time_id` / `events.location_id` 外键 |
| event—person 边 | `event_participants`（带 role） |
| char—user / char—others 有向边 | `stances`（holder→target）+ 事件共现 |
| char—location 直连边 | 经事件共现派生（只读，渲染期可算，无需存边） |
| event—event 边 | `event_links`（caused / led_to / preceded / contradicts） |
| 记忆—实体 边 | `memory_entity_refs` |

**注入表格 = 同一张图的四种邻接投影**（不是四张独立的表）:

| 投影 | 图语义 |
|---|---|
| 【关键实体】 | 节点目录（排序 = 节点度数，即被事件引用的次数） |
| 【事件时间线】 | 以时间节点为锚的枢纽邻接视图（§3.4） |
| 【关系立场】 | 实体—实体有向边清单 |
| 【相关细节】 | 单实体的属性子图 |

所有投影用**名字**互指——模型读到的不是孤立的表，而是一张可以游走的图；这也正是"高压缩"的图论本质：**节点描述存一次，边用引用表达**。

**更新图示补充的三个要素**（2026-10-13 第二版手绘图）:

| 新要素 | 含义 | 架构落点 |
|---|---|---|
| 事件注记 (behavior, decision, …) | 事件不只是"发生了什么"，还携带**行为与抉择**属性 | 落在既有自由文本列：`events.process`（行为）/ `cause_text`+`result_text`（抉择的因果两面）+ `event_participants.role`（谁发起/谁决定）。渲染为事件名后的短注记 `〔抉择: …〕`（§3.4），**不新增列** |
| 多角色子图共享空间节点 | char1 子图与 char2 子图通过**共享的 location / user 节点**交织成整网 | 已天然支持：多人同事件 = event_participants 多行；共现派生边渲染期可算；【关键实体】表按"被事件引用次数"排序，**共享热点（酒馆等高频空间）自动排最前**——正是图中度数最高的节点 |
| 颜色分层（红/绿/蓝） | 不同的边类型在同一张图上共存 | 文本投影里颜色 = **列语义**：参与/在场 → 参与者·地点列（名字引用）；因果 → ← 起因 / → 引出 / ⇠ 前承 标注列；属性 → 【相关细节】行。每条边都有明确的落列，无一悬空 |

### 4.6 事件节点信息正交性（用户明确原则 2026-10-13）

**事件不是"总结的文本"**。事件节点只承载**事件性信息**——发生了什么行为、什么抉择、什么转折；时间、人物、地点、组织这些信息已经由它的边和相邻节点表达，**不得再写进事件文本里**。违反即同一事实在注入中出现两遍，压缩失效。

这条原则约束两层：

| 层 | 现状/风险 | 落点 |
|---|---|---|
| **抽取层**（写入时） | 现有抽取 prompt 只要求"事件短标题/经过"，LLM 天然会写"暴雨第三夜，主角与艾拉在酒馆初遇"式的总结文本，把六要素全揉进正文 | `extractionService.js` prompt 增补硬约束：**title/process 中禁止出现已由结构表达的信息**——不写时间、不写人物名（发起/决定语义用 participants.role 表达）、不写地点；只写"初遇""卷宗失窃""当面对质"这类纯事件短语 + 行为/抉择注记。已在库中的旧数据不改（存取分离，原文不删），渲染层兜底 |
| **渲染层**（注入时） | 时间线的事件行若复述"第三夜主角在酒馆…"，与时间节点列/参与者列/地点列三重冗余 | §3.4 事件列与注记列**只写事件独有信息**；实体信息一律走列引用。注记内容同样禁止复述列信息 |

注：用户图示中 event4/event5 未标注注记仅是省略，不代表特殊语义——注记是可选的，有行为/抉择语义才写。

### 4.7 复现事件的口径：琐事归观察（用户选定 2026-10-13）

同一行为在多个时间点复现（"艾拉昨天/今天/明天去小卖部"）——不注入三行，也不注入"一行事件 + 时间列表"，而是**根本不进时间线**：

```
【事件时间线】里没有它。【相关细节】里出现：
| 艾拉 | habit | 常独自去小卖部 ×3 |
```

- **时间线是叙事骨架，只收叙事事件**：日常重复行为塞满时间线是 token 灾难，且每一行都在稀释真正重要的剧情节点；
- **归行为观察**：重复日常归入实体的 behavior/habit 类观察——自动走 L2 supersedes 折叠链，渲染为 `常去小卖部 ×3`，出现在【关键实体】/【相关细节】表。"复现频次 = 稳定模式"的语义由 ×N 计数承载，与 §4.1/§4.3 口径一致；
- **不做同题折叠**：写入幂等保持 `(chat_id, title)` 不变。若未来出现"叙事性同题事件"（每晚对峙但各有细节）的真实需求，再评估放宽为 `(chat_id, title, time_id)` + 渲染期时间锚点列表——留作后手，当前不做；
- 边界判定（"值不值得占时间线一个节点"）交给抽取 prompt，用正反例锚定：会面/冲突/抉择/转折 = 事件；买东西/路过/日常寒暄 = 观察。

## 5. 段落顺序与预算

```
画像 ──► 立场 ──► 关键实体 ──► 前情提要 ──► 事件时间线 ──► 相关记忆 ──► 相关细节
└──── 常驻: 各段独立预算, 预算外优先保证 ────┘  └──── 检索: 共享 tokenBudget ────┘
```

| 段 | 预算口径 | 默认值 |
|---|---|---|
| 画像表 | 独立 | 600 token |
| 立场表 | 独立 | 400 token |
| 关键实体表 | 独立 | 400 token |
| 前情提要 | 独立（现有） | 2000 token |
| 事件时间线 | 独立 | 500 token |
| 相关记忆 + 相关细节 | 共享现有 `tokenBudget`（1200） | 不变 |

- 预算超限时按 importance 降序截行（画像表按 category 排序不变，截行不截列）；
- **常驻段吃自己的预算，不吃检索预算**：各段独立预算已实现，响应的 `usedTokens` 只统计【相关记忆】+【相关细节】；`profileTokens` / `stanceTokens` 等单独上报，前端不会把两个口径混在一起显示；
- 预算不足时**从尾部截行，但至少保留一行**（常驻段不空段，与摘要"保新丢旧"同一哲学）；
- **空段不出段**：无数据时不输出表头（与现有四段行为一致），`/api/context` 响应里的 `profileCount` 等统计字段相应扩展（`stanceCount` / `entityCount` / `timelineCount`）。

## 6. 规模防线（防表格爆炸）

| 防线 | 默认值 |
|---|---|
| 画像表行数上限 | 40 行 |
| 立场表行数上限 | 20 行（importance 降序取） |
| 关键实体表行数上限 | 15 行（事件引用次数 × importance 降序取） |
| 事件时间线行数上限 | 12 行 |
| 检索行数 | 沿用 topK |
| 单元格截断 | 内容类列最长 60 显示宽, 截断加 `…` |
| 管道符转义 | 检索层 markdown 行中正文的 `\|` 替换为 `／`；对齐纯文本层无需转义 |

## 7. 语义同源与契约变更

**constants.js 新增**（一次定义，两端派生；✅ T1 已落地）:

```js
export const INJECTION_TABLES = {
  enabled: true,
  format: { resident: 'aligned', retrieved: 'markdown' },   // 取值与渲染器同名, 不做二次翻译
  headers: { profile: '【角色画像】', stances: '【关系立场】', entities: '【关键实体】',
             timeline: '【事件时间线】', memories: '【相关记忆】', chunks: '【相关细节】' },
  limits: { profileRows: 40, stanceRows: 20, entityRows: 15, timelineRows: 12, cellMaxWidth: 60 },
  budgets: { profile: 600, stances: 400, entities: 400, timeline: 500 },
  intensityBands: { low: 0.34, high: 0.67 },
  intensityLabels: { low: '低', mid: '中', high: '高' },
  stanceDisplay: { hiddenPrefix: '隐秘·', disguisedPrefix: '表面', plainLabel: '即本心',
                   unawareSuffix: '·对方不知', emptyBasis: '——' },
  recurrenceMark: '×',
  dedupe: { profileStanceOverlap: true, profileCategory: 'relationship' },
  sketchMaxWidth: 12,
  derivedMark: '※',
  fallbackOnError: 'bullets',
};
```

- `CONTEXT_SECTIONS` 扩展为七段（新增 `stances`、`entities`、`timeline` 三个 key），顺序即 §5 注入顺序，`order` 与数组下标一致；
- 段落**标题**也取自 `INJECTION_TABLES.headers`（bullet 回退路径同样取用），避免"表格化前后标题不一致"这种漂移；
- `/api/meta` 新增 `injectionTables` 字段下发以上全部值 + 七段 `contextSections`；
- `/api/context` 新增两个请求体开关：`injectTables`（表格化总开关，缺省用服务端默认，显式 `false` 才关）、`injectStances`（立场段单独开关）；响应新增 `tablesEnabled` / `stancesEnabled` / `injectionMode`（`tables` | `bullets` | `mixed`）/ `profileTokens` / `profileTotal` / `profileDropped` / `stanceCount` / `stanceTotal` / `stanceTokens`；
- `ENDPOINTS` 中 `/api/context` 的 `degradeNote` 更新（未配 embedding 时无【相关细节】段——既有承诺不变，只补新段描述）；
- **前端**：`settings.js` 只加两个开关键——`injectTables`（表格化注入，默认 true）、`injectStancesSection`（立场常驻段，默认 true）；开关可用性/文案全部读 meta，契约未载入时禁用（沿用现有降级原则）。前端**不出现**任何表格列名/阈值字面量。

## 8. 实现落点（零表变更清单）

| 文件 | 变更 |
|---|---|
| `server/src/services/tableRender.ts` | ✅ **已建（T0）**：`TableSpec` 类型、CJK 显示宽度计算、对齐纯文本渲染、markdown 行渲染、单元格截断与转义、分组锚点留空、首现展开追踪器、`×N` 标记 |
| `server/src/services/injectionService.js` | ✅ **已建（T1）**：`buildProfileTable` / `buildStanceTable`（取数 + 单元格格式化 + 预算截行），以及 `intensityLabel` / `stanceDisplayText` 两个纯函数 |
| `server/src/services/stanceService.js` | ✅ **已改（T1）**：新增 `resolveEntityName`（people/orgs 多态解析）、`chatStances`（本聊天生效立场 + 双端名 + 归拢排序）；`stanceOverview` 补 `holder_name` |
| `server/src/services/extractionService.js` | ✅ **已改（T2）** prompt 两项硬约束：① §4.6 信息正交性——title / process / cause_text / result_text 禁止写入时间、人物名、地点，只写事件性信息（附正反例）；② §4.7 琐事排除——日常重复行为不建事件，判据是"去掉这条剧情会不会少一个因果环节"（附反例）。幂等键仍为 title，旧数据一字不动 |
| `server/src/services/chunkExtractionService.js` | ✅ **已改（T2）** prompt 三项补充：① 反复出现的日常行为归 `aspect=habit` 观察（是稳定习惯，不是事件）；② 同一条观察每次照原样抽，**不自己合并**（折叠交给写入管线的相似度链，复现次数才是"稳定模式"的证据）；③ 环境/氛围的稳定特征归 `scene` / `atmosphere` |
| `server/src/services/graphService.js` | ✅ **已建（T2）** 新增只读图投影查询（零表变更、无副作用）：`chatTimeline(db, { chatId, limit })` —— events × participants × links × time_points（含 parent 章节）/ locations 聚合，按 `(time.seq, id)` 取最近 N 个再正序返回，因果边按方向各渲染一次；`keyEntities(db, { chatId, limit, windowIds })` —— 度数（person 走 participants / location 走 location_id / item·org 走 memory_entity_refs 且限定本聊天）+ 链头链深 + 速写原料 |
| `server/src/services/retrievalService.js` | ✅ **已改（T1/T2）** 常驻段分支（表格 / bullet 双路径）+ 三级退化（表格 → bullet → 整段跳过，每级都记 warn）；T2 接入关键实体表与时间线表、检索段 markdown 行化、跨段去重（按链头块 id）；新增 `entityCount` / `timelineCount` / `chunkDeduped` 等统计 |
| `server/src/domain/constants.js` | ✅ **已改（T1/T2）** 新增 `INJECTION_TABLES`（T1）+ `linkLabels` / `timeline` / `entities` 三组语义（T2），`CONTEXT_SECTIONS` 扩为七段 |
| `server/src/api/meta.js` | ✅ **已改（T1）**：`buildMeta` 下发 `injectionTables` |
| `server/src/api/routes.js` | ✅ **已改（T1）**：`/api/context` 接受 `injectTables` / `injectStances` |
| `server/test/tables.smoke.js` | ✅ **已建（T0）**：第八套，纯渲染器快照 |
| `server/test/injection.smoke.js` | ✅ **已建（T1）**：第九套，常驻段端到端（分组/※/名字解析/二阶语义/三档/去重/预算/回退/开关） |
| `server/test/timeline.smoke.js` | ✅ **已建（T2）**：第十套，图投影端到端（时间节点锚定与章节切换 / 因果三型方向化 / 裸 id 全部解析成名字 / 链深 ×N 不被截断 / 首现展开跨段只一次 / 检索层行化与共享预算 / 跨段去重 / prompt 约束存在性） |
| `src/settings.js` / `src/ui.js` / `settings.html` | ✅ **已改（T3）**：两个新开关 `injectTables` / `injectStancesSection`（面板「注入形态」小节），值经 `src/injector.js` 的 payload 显式下发；契约里的 `injectionTables`（格式/行数上限/常驻预算/立场显示规则）在「诊断与契约」原样展示；「检索预览」新增**注入原文**区块（与 prompt 同一份字节）+ 各段条数 + 形态 |
| `check-static.mjs` | ✅ **已改（T3）**：新增「注入形态开关存在」+「前端未硬编码注入表格的段落标题/列名」（扫描 4 文件 × 12 字面量）；顺手把 settings.html / settings.js 注释里的 `【…】` 段落标题改为 `「…」` |
| `check-contract.mjs` | ✅ **已改（T3）**：新增 15 条 —— 七段顺序、`injectionTables` 齐备（headers/budgets/limits/stanceDisplay/recurrenceMark）、`/api/context` 默认 tables、`injectTables:false → bullets` 且不再出现分隔行、`injectStances:false → 只关立场段` |
| `server/test/routes.smoke.js` | ✅ **已改（T3）**：HTTP 层开关链路（默认 tables / 回退 bullets 无分隔行 / 只关立场段） |

## 9. 风险与权衡

| 风险 | 对策 |
|---|---|
| 常驻表格比 bullet 贵 30-50% token | 每表行数上限 + 独立预算兜底；面板可一键关回 bullet 路径 |
| 正文里含 `\|` 破坏 markdown 行 | 渲染器统一替换（§6）；快照测试覆盖此 case |
| 中英混排对齐错位 | CJK 显示宽度函数 + 快照测试钉死；这也是选对齐纯文本只用于常驻层的原因——常驻层内容短且稳定，检索层放弃对齐 |
| TS 混入全 JS 代码库 | 只新增一个 `.ts` 模块，可擦除语法 + 显式扩展名；不引入构建步骤，`npm start`/`npm test` 命令不变 |
| 立场段是新内容注入 | 独立开关 `injectStancesSection`，默认开，可单独关 |
| 时间节点/首现展开逻辑把渲染器变复杂 | 分组与展开是纯函数（输入行数据 → 输出文本），快照测试逐 case 钉死；渲染异常回退 bullet |
| LLM 抽取惯性写总结式事件文本（把六要素揉进正文） | 抽取 prompt 硬约束（§4.6）+ 渲染层兜底：注入只取 title/注记，实体信息一律来自列引用（列是真相源，不信任正文自述） |
| 琐事/事件边界误判（该建事件的没建，或琐事挤进时间线） | prompt 正反例锚定（§4.7）；两个方向的误判都无害——多一行事件行只是多花十几个 token，琐事落进观察链还有 ×N 兜底；不引入写入口径变更 |

## 10. 交付顺序（渐进）

- **T0 ✅ 已完成（2026-10-13）** `server/src/services/tableRender.ts` + `server/test/tables.smoke.js`：CJK 显示宽度 / 补空格 / 截断、对齐纯文本渲染（含分组锚点留空）、markdown 管道行渲染（含 `|` 转义）、首现展开追踪器、`×N` 复现标记。纯函数无副作用，`npm test` 扩到八套全绿
- **T1 ✅ 已完成（2026-10-13）** 常驻层落地：
  - `INJECTION_TABLES` 进 `constants.js`（标题/上限/预算/立场显示规则/去重开关），`CONTEXT_SECTIONS` 扩为七段，经 `/api/meta` 下发；
  - `injectionService.js` 新增：`buildProfileTable`（类别分组 + `※` 溯源 + 立场重叠去重）、`buildStanceTable`（双端名解析 + 二阶语义压"表露"列 + 强度三档 + 依据占位）；
  - `stanceService` 补 `resolveEntityName` / `chatStances`（持方按最高 importance 归拢排序）；
  - `assembleContext` 接入常驻段：表格 / bullet 双路径 + 三级退化（表格 → bullet → 整段跳过），`usedTokens` 修正为只统计检索段；
  - `/api/context` 新增 `injectTables` / `injectStances` 开关；`test/injection.smoke.js` 第九套 + `meta.smoke` 断言同步 → `npm test` 九套全绿
- **T2 ✅ 已完成（2026-10-13）** 图投影层落地：
  - `graphService.js` 新增（只读、零表变更）：`chatTimeline`（四表聚合，`(time.seq, id)` 取最近 N 个再正序返回；因果边按方向各渲染一次；对端事件在窗口外也取标题，跨窗口因果线不断）、`keyEntities`（度数 + 链头链深 + 速写原料）；
  - `injectionService.js` 新增：`buildEntityTable` / `buildTimelineTable` / `createInjectionContext`（共享首现追踪器）/ `entitySketch` / `eventNote` / `causalText` / `timeAnchor` / `buildRetrievedTable`；
  - `assembleContext` 接入两段 + 检索段 markdown 行化 + 跨段去重（按链头块 id），响应新增 `entityCount` / `timelineCount` / `chunkDeduped` 等；
  - 抽取层 prompt 两项硬约束 + 属性抽取三项补充；
  - `test/timeline.smoke.js` 第十套 + `meta.smoke` 断言同步 → `npm test` 十套全绿。

  实现中发现并修掉的真问题（都写进了测试）：
  1. **章节前缀会让分组留空失效**：时间线首行锚点是 `第三章 / 第三夜 #7`，同一节点的第二行渲染文本并不相等，靠文本比对驱动的 `groupKey` 会漏掉该留空的行 → 改为**按 `time_id` 自己留空**（章节前缀只出现在切换处）；
  2. **`×N` 会被单元格截断吃掉**：复现计数在速写末尾，而速写常常超长 → 改为**先给 `×N` 预留宽度再截断正文**，否则最有信息量的"稳定行为模式"信号永远看不见；
  3. **description 与链头观察常常同文**：拼两遍等于把压缩又花回去 → 互相覆盖时只留一份（`entitySketch` 的 contains 判断）；
  4. **实体目录会跨聊天泄漏**：`description` 是全局字段，若按"有描述就收录"来筛，新开一条聊天会凭空冒出所有描述过的角色/地点 → 入目录门槛改为**本聊天存在证据**（被本聊天事件引用过，或被本聊天的观察块看过），item/org 的度数也经 `memory_entity_refs → memories.chat_id` 限定到本聊天；
  5. **跨段去重不能按文本比对**：速写为 `×N` 预留宽度后必然被截断，文本相等判断一定漏 → 改为**按链头块 id 判重**（精确，且只对真正渲染进表的那部分实体生效）。
- **T3 ✅ 已完成（2026-10-13）** 前端开关 + 两套自检 + 端到端冒烟：
  - `settings.js` 新增 `injectTables` / `injectStancesSection`（默认 true，属**用户偏好**，不是语义复制）；`settings.html` 在「记忆注入」下加「注入形态」小节；`ui.js` 绑定 + 三处展示（最近状态的形态与各段条数、「检索预览」新增**注入原文**区块、契约里的 `injectionTables` 原文）；
  - `injector.js` 的 payload 显式下发这两个偏好 —— 关掉即由**服务端**走 bullet 回退，前端不自己拼文本；
  - `check-static.mjs` 加两道防线：开关存在 + **前端不得硬编码表格段落标题/列名**（12 个字面量 × 4 个文件；顺带把原先写在设置里的 `【前情提要】` 改成 `「前情提要」`）；
  - `check-contract.mjs` 加 15 条：七段顺序、`injectionTables` 齐备、`/api/context` 默认 tables、`injectTables:false → bullets` 且不再出现对齐表分隔行、`injectStances:false → 只关立场段`；
  - `test/routes.smoke.js` 加 HTTP 层开关链路断言（同一组行为，在路由边界再钉一次）；
  - 端到端实测（真实 express + 真实前端 `api.js`/`meta.js`）：契约载入 → `/api/context` 返回七段表格文本（画像/立场/关键实体/时间线），`injectionMode=tables`；`injectTables:false` → `bullets` 且无分隔行；`injectStances:false` → 立场段消失而其余段照常。

每步跑全 `npm test` 十套 + 前端两套自检，全绿才进下一步。
