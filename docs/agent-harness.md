# Agent Harness 插件体系设计（替代酒馆前端）

> 基于 deepseek-harness (dsh) master 分支 docs/capability-seams.zh.md 的实际接缝核对，
> 2026-10-14。dsh 处于 developer preview，API 有破坏性变更风险，插件须锁定版本。

## 背景与定位

AIRP 记忆内核（`server/`）是宿主无关的 HTTP 服务，真正的耦合只在酒馆前端适配层
（`index.js` / `src/` / `settings.html`）。dsh 是 DeepSeek 官方开源的 agent
harness（MIT，TS monorepo，`npx @deepseek-ai/dsh web`），内核是 Cordis 插件框架，
**一切皆插件**：LLM、工具、会话、压缩、UI 全部是可替换/可扩展的 Cordis 服务。

在 dsh 上做一套 AIRP 插件，复用同一套 server API，绕开酒馆全部转译逻辑：

- 不再有楼层号量纲——会话是 append-only 事件流，turn 有明确的 start/end 事件
- 不再有 /hide 隐藏——压缩由 compaction 接缝负责，语义直白
- 不再有 MESSAGE_RECEIVED / GENERATION_AFTER_COMMANDS 事件适配——dsh 的
  session 事件流是确定性的、仅追加的日志
- 不再有"扩展延迟激活""活体 extensionSettings"这类宿主陷阱

酒馆前端继续保留，两条腿并存，用检索质量对比数据决定取舍。

## dsh 关键接缝（已核对）与 AIRP 职责映射

| AIRP 职责 | dsh 挂点 | 机制 |
|---|---|---|
| 每轮注入（/api/context） | **`ctx.systemPrompt`** | 它是"为每个步骤收集提示词各部分"的服务，AIRP 插件作为贡献方把注入文本拼进去。消费方包括 agent-loop，时机天然正确 |
| 每轮抽取（/api/extract） | **`ctx.sessions` 会话事件流** | 仅追加的 Session 日志，turn-start/turn-end 有明确事件（`ctx.workspaceChanges` 就是按 turn-start/end 做 diff 的先例）。插件消费事件流，turn-end 时取该 turn 的消息 POST /api/extract |
| 长对话总结 | **`ctx.compaction`（seam）** | 压缩是可替换接缝！官方实现 compaction-basic 消费"步骤后的压力事件"+`ctx.tokenMeter`（按会话隔离的 token 测量）。AIRP 可注册自己的 compaction 提供方：压力事件触发 → POST /api/summarize → 用摘要替换旧窗口 |
| 主动记忆工具 | **`ctx.tools`（core）** | 核心工具注册表，统一守卫管线（策略前处理→守卫→分派→后处理→观测）。注册 memory_search / memory_browse / memory_note，schema 从 /api/meta 派生 |
| 前情提要必然在场 | compaction 提供方自身保证 | 摘要写入记忆库后，注入由 systemPrompt 通道带回——架构上"摘要是被压缩正文的唯一载体"这一原则原样成立 |

哲学层面的意外收获：dsh 的"**Session 日志是唯一事实来源**，反馈/投影/压缩/hooks
全部通过消费/追加会话事件实现"，与 AIRP"向量只做索引、原文一字不删、事件网络是
枢纽"是同构的。两边都是 append-only 日志 + 投影。

## 插件组成（airp-dsh-plugin，单个 Cordis 插件包）

```
airp-dsh-plugin/
  ├─ inject.ts    ctx.systemPrompt 贡献方 ← POST /api/context
  ├─ extract.ts   ctx.sessions 事件消费者 → POST /api/extract（turn-end）
  ├─ compact.ts   ctx.compaction 提供方  → POST /api/summarize
  ├─ tools.ts     ctx.tools 注册 memory_* 工具（schema 读 meta）
  └─ config       serverUrl / characterId / characterName / userName / 策略开关
```

语义同源原则原样保留：枚举/阈值/文案全部读 `/api/meta`，插件内零硬编码。

## 与酒馆版的关键差异

1. **触发量纲从楼层数变成 token 数**。`ctx.tokenMeter` 提供精确的按会话 token
   测量，这是 agent 原生的正确量纲。`SUMMARY_POLICY` 新增 `triggerTokens`
   字段经 meta 下发（constants 单源，新增而非分叉）；酒馆前端继续读
   triggerFloors，互不影响。
2. **隐藏机制取消**。压缩=窗口替换，摘要正文已在记忆库；纯记忆网络形态
   （summaryEnabled=false）依然是合法配置。
3. **身份锚定零改动**。三道防线全在 server 侧，插件只传 characterName/userName。

## 风险

- dsh 是 developer preview，**会破坏兼容性**。对策：锁版本 + 插件只依赖
  capability-seams 文档钉死的核心接缝（systemPrompt / sessions / compaction /
  tools 是 core 或稳定 seam，文档有完整性守卫），不碰 experimental 包。
- compaction 自实现的窗口替换语义需要读 compaction-basic 源码确认接口形状，
  这是开工前第一件事。
- Node 版本要求 ^22.19 || >=24，与 server/ 的 Node22 一致，无冲突。

## 迁移策略（渐进）

1. **V9-a（原型）**：inject.ts + extract.ts 两个挂点，打通"对话→自动抽取→
   自动注入"最小闭环。server 零改动。
2. **V9-b（总结）**：compact.ts 注册 compaction 提供方，constants 新增
   `SUMMARY_POLICY.triggerTokens`。
3. **V9-c（主动工具）**：tools.ts 暴露 memory_search 等，观察模型主动检索行为。
4. **对比实验**：同一角色卡在酒馆前端与 dsh 前端各跑 100 轮，对比注入命中率
   与检索质量，再决定酒馆前端去留。

## 复用与验证

- `check-e2e-10floor.mjs` 的 40 项断言全读 meta、语义零硬编码，可改造为 dsh
  版 E2E（驱动 dsh headless CLI 会话替代模拟酒馆 chat）。
- `check-contract.mjs` / `meta.smoke.js` 不动，继续钉死前后端语义一致。

## 明确不做的

- 不重写记忆内核的任何部分
- 不在插件里复制枚举/阈值/文案（一切读 meta）
- 不依赖 dsh experimental 包（hooks-claude-code / claudeCodeMods 等）
- 不动酒馆前端，直到对比实验有结论

## 落地路线调整（2026-10-14 实施）：MCP 适配器优先，原生插件后置

上面的设计是最终的**原生插件**形态。但开工顺序调整为:先用 **MCP 适配器**打通，
原因:原生插件要读 compaction-basic 源码定接口、要跟着 dsh 的 developer preview
改动跑，而 MCP 是跨 agent 的行业标准 —— 同一层皮在 dsh、WorkBuddy、Claude Code
上都能挂，核心资产不押在单一 harness 的原生 API 上。

### 已完成

| 产物 | 位置 | 说明 |
|---|---|---|
| MCP 适配器 | `server/mcp/index.mjs` + `tools.mjs` | 零依赖 NDJSON JSON-RPC;13 个 `memory_*` 工具;描述/枚举从 `constants.js` 派生(语义同源) |
| 适配器自检 | `server/test/mcp.smoke.js` | 握手 / 工具清单 / 上游不可达降级 / 未知工具 四组断言 |
| 纪律 skill | `skills/airp-memory/SKILL.md` | 何时读、写入三步顺序、沉淀时机、红线;跨 agent 通用格式 |
| AIRP profile | `~/.dsh/profiles/airp/cordis.patch.yml` | `insert` 一条 mcp-client + `skill-filesystem` 只认仓库 skills/ |
| 一键启动 | `启动AIRP模式.bat` | 起记忆服务 + `dsh --profile airp` |

**双模式隔离**(用户硬要求):原版走 `profile=desktop`(Electron 独占，我们一行不改)
或 `--profile web`;AIRP 走 `profile=airp`。插件树、skill 根都各归各，
`includeDefaultRoots: false` 让共享的 `~/.dsh/skills` 在 AIRP 模式里不可见。

### 与原设计的差异（修正）

1. **注入通道**：不再由插件主动经 `ctx.systemPrompt` 注入，改为 agent 按 skill 纪律
   调 `memory_context`。若实测"自觉性"不够，再补原生插件走 systemPrompt —— 这一步收益
   仍在，但不再是开工前提。
2. **沉淀触发**：量纲从楼层数改为**会话/段落边界**(skill 纪律),而非 `tokenMeter` 压力事件。
   `SUMMARY_POLICY.triggerTokens` 的改造先不做。
3. **tools.ts 的职责**：已由 MCP 适配器承担过半，原生插件只需补 systemPrompt/compaction 两个接缝。

### 待办（未变）

- V9 原生插件:systemPrompt 贡献方 + compaction 提供方(先读 compaction-basic 定接口)
- E2E:`check-e2e-10floor.mjs` 改造成驱动 dsh 会话的版本
- 记忆服务鉴权:当前无鉴权且 config 可能是 `0.0.0.0`，接 harness 前应改回 `127.0.0.1`

## AIRP 模式 preset 设计（2026-10-14）

**结论：不要用 dsh 的极简模式（preset-minimal）。** 实测它的定义是
`persona(prefix: "You are a helpful software engineer assistant.", complete: true)`
+ 一个 persistent-shell 组 —— 这是**基准测试**用预设：人设被完整覆盖（角色卡基调会被
"软件工程师助手"顶掉），且里面没有 MCP 工具、没有 tool-skill、没有 compaction，
AIRP 的三条命脉（取注入文本、加载纪律、语义沉淀）全断。

正确做法是**自建预设**，仓库内 `dsh/airp-profile.patch.yml` 是唯一真源
（`启动AIRP模式.bat` 每次启动复制到 `~/.dsh/profiles/airp/cordis.patch.yml`）。

### 设计三原则

1. **人设归角色卡，不归 harness**：`system-prompt` 关掉 `includeHarnessIdentity`
   与 `includeRuntimeContext`（不自我介绍、不塞 cwd/平台信息，沉浸且省 token）；
   预设内 persona 用 RP 基调但**不设 `complete: true`**，留出角色卡注入位。
2. **写入只能走记忆工具**：预设工具集里**不放 bash / pwsh**，所以模型没有"绕过
   MCP 直接改 SQLite"的能力 —— 把"唯一写入口"从纪律升级为能力缺省。
3. **纪律自动在场**：`agent-instructions` 的 `instructionFileCandidates` 改成
   `['AIRP.md']`，仓库根的 `AIRP.md` 每轮自动注入，不赌模型自觉加载 skill；
   详细 playbook 仍在 `skills/airp-memory/SKILL.md` 按需加载。

### 预设内容对照

| 保留 | 理由 |
|---|---|
| persona（RP 基调，非 complete） | 角色扮演的第一层基调 |
| agent-instructions（只认 AIRP.md） | 每轮纪律自动在场 |
| tool-fs | 读角色卡 / 设定 / 记忆投影（写路径不给） |
| skill-filesystem + tool-skill | 纪律手册按需加载；skill 根只认仓库 `skills/` |
| compaction 组（thresholdRatio 0.85） | 只做窗口管理，避免抢在 memory_summarize 前吃掉原文 |
| MCP（根层 mcp-airp） | 13 个 `memory_*` 工具 |

| 砍掉 | 理由 |
|---|---|
| bash / pwsh | 能绕过记忆写入口直接改库；也是最大的 token 与误操作来源 |
| subagent / delegation | 会分叉人设，RP 不需要 |
| goal / todo / plan-mode | 任务导向，会诱导模型写计划而不是对话 |
| tool-web / workflow / cordis / jobs | 与剧情无关的 schema，每轮都白付 |

另有两条全局配套（写在 profile 补丁里，属 AIRP 模式专属）：

- `agent-preset-registry.default: airp-roleplay` —— AIRP 模式开局即该预设；
  UI 里仍可按会话临时切回 standard 做对照测试。
- `permission` 新增 `airp` 预设（`sandbox: workspace-write` + `approval: never`）——
  角色扮演不能每一步弹审批弹窗。注意补丁的 config 是**整体替换**，
  所以把出厂两个预设一并带上，避免 UI 丢选项。

### 两个待实测项（设计里不敢拍死的）

1. **MCP 工具在预设作用域内是否可见**。mcp-airp 注册在根作用域，预设是子作用域；
   mcp-client 文档说"调用方作用域为空时不添加 MCP 工具"，倾向可见，但需实测：
   开一个会话让模型列工具，或直接看它会不会调 `memory_context`。
   若不可见 → 把 mcp 条目搬进预设的 plugins（serverName 不能与根层重复）。
2. **tool-fs 是否含写入能力**。其配置 schema 只暴露 read* 旋钮，但工具本身是否
   只读未能证实（包在 app.asar 内）。若它其实能写，把 `sandbox` 改成
   `read-only` 即从沙箱层封死写入（需同时确认 read-only 不会挡住 MCP 子进程）。

### 验证记录

- `dsh --profile airp --dump-config`：**零告警**；`preset-airp-roleplay` 六个插件
  齐全，`agent-preset-registry.default = airp-roleplay`，system-prompt 两开关为 false
- 真实启动：Web UI 起来，进程表出现 `C:/Program Files/nodejs/node.exe mcp/index.mjs`
  （父进程即 dsh），无 boot 报错
- 踩坑：YAML 里未加引号的 `description` 含 `: `（冒号+空格）会解析失败，已改为单引号

## 宿主修正：AIRP 落在桌面端（2026-10-14 19:00，实测后推翻前一节的前提）

前一节把 AIRP 做成了"浏览器里另开一个 dsh（profile=airp）"，但用户的宿主是**桌面端 App**。
实测查清了两件事：

- 桌面端在 app.asar 里**硬编码 `profile: "desktop"`**（全仓只有这一处），
  且 `DSH_PROFILE` 只是导出给 shell 的环境变量，不是选择器 → 桌面端永远不读 `profiles/airp`。
- 但 `agent-preset-registry` 驱动的 preset **是 UI 级可切换的**（设置 → Agent 预设），
  这才是"两套互不干扰"的正确粒度。

### 现在的结构

| 会话 | 预设 | 记忆工具 | 原版是否受影响 |
|---|---|---|---|
| 桌面端普通会话 | 标准模式（默认） | 不出现 | — |
| 桌面端 AIRP 会话 | **AIRP 角色扮演**（自定义） | 13 个 `memory_*` | 无 |
| 浏览器隔离变体 | profile=airp，默认即 AIRP 预设 | 13 个 | 无（独立 profile） |

关键改动：**MCP 从根层搬进预设内部**。这样原版会话连那 13 个工具都不会注册，
隔离从"配置约定"变成结构事实（`grep -c '^- id: mcp-airp'` 在根层为 0）。

### 真源与同步

```
dsh/airp-preset.patch.yml     ← 唯一真源（预设本体，含 MCP、persona、纪律、压缩）
dsh/sync-profiles.mjs         ← 生成到两个 profile
  ├─ ~/.dsh/profiles/airp/cordis.patch.yml      整份生成（+ system-prompt/权限/默认预设）
  └─ ~/.dsh/profiles/desktop/cordis.patch.yml   只追加带标记的块，保留 App 自己写的条目
```

同步用 `# >>> AIRP-PRESET ... >>>` / `# <<< AIRP-PRESET <<<` 标记块：
桌面端那 6 条 App 自己写的条目（ui-settings-general / agent-default-model / ui-chat …）
原样保留，脚本只重写标记块之间。**默认权限预设与默认 Agent 预设都不动** ——
桌面端原版行为与今天完全一致，AIRP 只是下拉里多出来的一张卡。

### 验证证据（全部实测）

- 桌面端「Agent 预设」设置页出现 **自定义 → AIRP 角色扮演（airp-roleplay）** 卡片
- 桌面端进程（`...\profiles\desktop`）**自己拉起了记忆 MCP 子进程**：
  `"C:/Program Files/nodejs/node.exe" mcp/index.mjs`，其父进程是 `DeepSeek Harness.exe`
- `dsh --profile airp --dump-config`：零告警；预设 7 个插件齐全；根层无 mcp-airp
- 桌面端补丁同步后：原 6 条条目仍在，仅多出标记块

### 两个提醒

1. 桌面端 App 会自己改写 `profiles/desktop/cordis.patch.yml`（写它自己的设置项），
   所以**手改这个文件没有意义**，改仓库真源再跑同步。
2. 权限：桌面端默认权限预设保持出厂值（`approval: ask`）。用 AIRP 预设开新会话时，
   在 UI 把权限切到「AIRP 角色扮演」（`approval: never`, `sandbox: workspace-write`）
   就全程不弹审批 —— 没切成也不影响功能，只是每步会问。

## 可借鉴的 dsh 架构经验（2026-10-14，按源码复核后修订）

> 本节先有过一版凭印象写的提案，读完全部源码后推翻/修订如下。
> 引用的行号对应本次调研时的代码。

前提不变：AIRP 是单进程本地服务，只搬**思想**，不搬"一切皆插件"运行时。

### 先更正两条之前的臆测

| 之前说法 | 源码事实 |
|---|---|
| "段名/顺序/预算散在 constants 与 tableRender 两处" | **不准确**。段标题/限额/预算确实单点在 `INJECTION_TABLES`（constants.js:163-330），`tableRender.ts` 是纯排版（对齐/截断/分组），不含语义字面量。语义同源这块本来就做到了 |
| "建议加 token 压力触发（triggerTokens）" | **撤回**。楼层计数是酒馆前端的量纲（`SUMMARY_POLICY.triggerFloors: 10`，constants.js:555）；harness 路线上窗口压缩由 dsh 的 compaction 接缝负责，语义沉淀由会话边界触发。这条属于旧前端的配套，不是 harness 路线的改进 |

### 发现一（源码新发现，最实在）：抽取三段由调用方编排，不变式裸露

`/api/extract` → `/api/extract-attributes` → `/api/extract-stances` 是三条独立路径
（routes.js:263 / 325 / 424），三个抽取器各自 `llm.chat` 一次
（extractionService.js:223、chunkExtractionService.js:50、stanceExtractionService.js:42）。
"同一段文本 + 同一组 sourceMessageIds"这个**正确性不变式，目前只靠调用方纪律维持** ——
酒馆前端靠代码保证，dsh 模式下靠 SKILL.md 的文字纪律保证。

改进：服务端加一个组合入口（如 `POST /api/observe`），内部按序跑三步并汇总报告；
三个单步端点保留给调试。收益：①MCP 暴露面 3 → 1（省两个工具 schema）②少两次往返
③不变式收回服务端（文本/来源由服务端一次性绑定，避开"agent 传了不同文本"的静默错位）。

### 发现二：`CONTEXT_SECTIONS` 是文档契约，不是执行契约（真实风险）

`assembleContext`（retrievalService.js:132-422）**手写**了 8 段的顺序与依赖：
实体表先把速写登记进共享 tracker、时间线再复用（:219 → :245，靠局部变量传递）。
而 `CONTEXT_SECTIONS[].order`（constants.js:141-152）**只被 meta.js 读取**，
没有任何代码或测试把它和实际组装顺序绑在一起 —— `check-contract.mjs:201` 校验的
是"声明里的 key 顺序等于预期字面量"，`assembleContext` 换个顺序它照样通过。

同时每段的统计字段是手写展开的（返回 40+ 字段），`profileCount` / `stanceCount` /
`timelineCount` / `pendingCount` / `injectionMode` 都是**前端在用的 API 面**
（src/ui.js:314-334、src/injector.js:105）。

改进：引入段注册表 —— 每段声明 `{ id, order, dependsOn, budget, render, counters }`，
`assembleContext` 变成按注册表迭代；计数器由注册表自动收敛成返回字段。
收益：①声明与执行合一，顺序/依赖不再靠人脑同步 ②新增段只登记一次
③加一个测试断言"注册表顺序 = 返回文本里的段出现顺序"，把当前这个洞钉死。
约束：返回字段名不能变（前端与 check-contract 依赖），所以计数器要做成**同名的自动收集**。

### 发现三：投影只在 prompt 出口渲染，缺文件出口

所有投影（画像/立场/关键实体/时间线/待兑现/检索段）都只在
`assembleContext` 里渲染成 prompt 文本（`tableRender` 输出）。
没有第二条出口 —— 而 harness 的语义是"agent 能读文件"。

改进：复用同一批 builder，加**只读文件出口**（`projections/<id>.md`，按需重算/落盘）。
收益：常驻注入可以只留高频段，详尽视图让 agent 按需读，注入预算不再是天花板。
成本低（builder 已存在），风险只在"何时重算"（写路径后失效即可）。

### 发现四：prompt 内联在服务里，且存在跨 prompt 共享策略

5 处 prompt 内联在 4 个文件中：`extractionService.js:21`（导出）、
`chunkExtractionService.js:16`（导出）与 `:39`（未导出）、
`stanceExtractionService.js:8`（未导出）、`summaryService.js:22`（函数生成）。
而共享策略是**复制文本**实现的：身份锚定段（extractionService.js:222 `buildIdentityAnchor`）
与"原样重复照原样抽"要求同时出现在述谓与属性两个 prompt 里。

改进：抽到 `prompts/` 目录，共享片段（身份锚定、原样重复、JSON 输出约束）做成可组合片段。
收益：调 prompt 不动代码、可 diff、可回归对比，与 `AIRP.md` / skill 同一套管理方式。

### 发现五（修正我原来的说法）：写路径有两条，不该合并抽象

- `chunkService.recordObservation`（chunkService.js:65-121）：属性槽三操作，
  顺序 = 先判重述（指纹）再判相似度（余弦），三行注释专门解释为什么不能反
- `extractionService.persistInstances`（:259-308）：事件/要素落库，
  事务内有序（人物地点 → 时间点 → 实例+嵌套 → 因果边），共享可变 `ctx`/`out`，
  事务外还有后置 `alignPropositions`（:236-241，容错不改结果）

两条路径语义不同（属性观察 vs 事件），**强行统一只会多一层**。
真正有价值的是给 `persistInstances` 抽显式阶段接口（它的 4 个阶段 + 后置对齐正好是
pre/execute/post 形态），让 V6 遗留项（题元析取、量词、item/org 填充者、NLI 判重述）
各自成为一个阶段，而不是继续往主干里插代码。

### 明确不抄的（不变）

- 不搬 Cordis/"一切皆插件"运行时：单进程本地服务，抽象成本大于收益
- 不把 dsh 的窗口替换语义搬进摘要通道：**原文一字不删**是铁律，摘要只新增投影
- 不为"可替换内核"重构 DB 层：schema 冻结在 v8，收益为零、风险是全套回归

## ①② 已落地（2026-10-14 晚）

### ① 组合抽取 `/api/observe`（三段一次跑完）

| 改动 | 文件 |
|---|---|
| 管线声明（id/顺序/依赖/标签/端点） | `domain/constants.js` → `OBSERVE_PIPELINE`，经 `meta.observePipeline` 下发 |
| 服务端编排 + 共享入参绑定 | `services/observeService.js`（新增） |
| 端点 | `api/routes.js` → `POST /api/observe`；`ENDPOINTS` 加声明（needsLlm=true / needsEmbedding=false / degrade=silent） |
| MCP 面 3 → 1 | `mcp/tools.mjs`：`memory_extract` + `_attributes` + `_stances` 合并为 **`memory_observe`**（13 → 11 个工具） |
| 单步端点 | 三个全部保留（调试 + `steps` 参数补跑） |

关键语义：顶层 `ok:true` **不代表三步都成** —— 失败/跳过记在 `steps.<id>`，`partial` 标记是否需补跑。
embedding 不可用时属性步跳过**且不发 LLM 请求**；任一步失败不中断其余步（否则一次故障丢三段数据）。

顺手收敛的一个不一致：三个抽取器形参形状不同（`extractInstances(db, llm, opts)` vs
`extractStances(db, opts)`），现在归到 `observeService` 的 RUNNERS 一处适配，调用方不必再记。

### ② 注入段注册表（声明 = 执行 = 契约）

| 改动 | 文件 |
|---|---|
| 段注册表：`{id, key, order, deps, fields, prepare, run}` | `services/injectionSections.js`（新增） |
| 召回函数独立成模块（避免注册表 ⇄ 编排器循环） | `services/memorySearch.js`（新增，`retrievalService` 继续 re-export） |
| 编排器瘦身：手写 8 段 + 40 个统计字段 → 按注册表迭代 | `services/retrievalService.js`（509 → 68 行） |

两阶段执行（同 dsh 的 Fetch/Swap 形态）：`prepare` 取数（按 `deps` 拓扑排序，成环/依赖缺失直接抛错），
`run` 按 `order` 出段 —— **取数顺序与出段顺序解耦**（stances 先取数供画像去重，但画像仍先出段）。

闭环的洞也补上了：`CONTEXT_SECTIONS` 以前只是下发给前端的文档，
现在注册表顺序与它由测试钉在一起（改一边另一边必红）。

### 验证证据

- `npm test`：**17 套全绿**（原 15 + 新增 `observe.smoke` / `sections.smoke`）
- `observe.smoke`（26 项）：三步收到的 `user` 文本逐字相同、落库的 `source_message_ids` 三段一致、
  单步失败不中断其余步、embedding 缺失时不发 LLM 请求、`steps` 只跑指定步、未知步名 400
- `sections.smoke`（17 项）：注册表顺序 = `CONTEXT_SECTIONS` 顺序、依赖拓扑正确、
  成环/缺依赖抛错、**40 个历史字段一个不少**（清单从 `git show HEAD` 抽出后冻结）、
  文本里段出现次序 = 注册表顺序
- 真实服务（新代码另起 7781 验证，避开用户已占用的 7780）：`/api/observe` 返回
  `chatId 必填` / `未知的抽取步: nope`；`meta.observePipeline` 正常下发；端点数 23 → 24；
  `check-contract.mjs` 全部通过

### 一个操作提醒

`memory_observe` 是新代码才有的工具。**已运行的记忆服务（7780）与 dsh 里的 MCP 子进程都必须重启**
才会看到 11 个工具的新清单 —— 只重启 dsh 不够（适配器进程由 dsh 拉起，但它 import 的是仓库里的
constants，旧服务仍能跑旧端点）。顺序：重启记忆服务 → 重启 dsh（或让它重连 MCP）。

## ③ 合并抽取（一次 LLM 调用）+ V9 事件判等（2026-10-14 晚）

用户决策：**"LLM 调用只一次，剩下的是工程上的优化和设计"**。

### ③ 合并抽取（`POST /api/observe` 默认 `mode: merged`）

| 改动 | 文件 |
|---|---|
| 合并 prompt（四分区输出）+ 一次调用 + 分区落库 | `services/mergedExtraction.js`（新增） |
| 三个写入段从各自抽取器里拆出（供合并路径复用） | `persistInstances` / `persistObservations` / `persistStances` |
| 编排：merged 默认，`steps`→split，整份解析失败→split-fallback | `services/observeService.js` |

**真正的收益不是省 token，而是恢复跨层锚点**：分开抽时属性步/立场步看不到事件步刚抽出的实例，
schema 里留的 `valid_from_event_id` 在自动路径上**永远为空**（grep 全 src 证实：只有手动端点
与存储层引用它）。合并后模型能在同一份输出里用 `event: "<实例 label>"` 引用自己刚抽的实例 ——
实测真实模型会填，响应里的 `anchored` 就是命中计数。

**踩到的坑（假 LLM 不会暴露）**：`extractAll` 一开始没显式传 `maxTokens`，于是走了会话档
（`config.llm.maxTokens = 2048`）→ 输出在 observations 中途被截断，`stances` 整段消失，
而**测试全绿**。修法：显式传 `LLM_LIMITS.extractionMaxTokens`，并把"哪一层没出现在输出里"
作为 `missingZones` 如实上报（截断与"确实没有"同形，只报事实不猜原因）。

### V9 迁移：事件判等键必须带来源窗口（修数据丢失）

合并跑通后立刻发现：模型每个窗口都从 `e1` 编号，而 events 的判等键是 `(chat, title)`、
且 `title` 曾被写成 label → **第二段剧情的事件被静默吞并**。实测：窗口 1 落 2 条，窗口 2 落 0 条。

修法（迁移 008）：`events` 加 `label`（与描述性 title 分列）+ `confirms`；
判等键改为 `① title+时间点` 或 `② label+来源窗口`；命中即重述（不新增行，`confirms+1`）。
前提是**只在实例带 label 时判等** —— 无 label 时 title 回落到动词，多条从句同为"去"会互相吞并。

复验（真实模型）：窗口 1 落 `e1:放回匕首 / e2:转身出门`，窗口 2 落 `e1:放长剑 / e2:看了一眼`，
标题不再是 "e1"，两条都完整落库。

### 验证证据

- `npm test`：**18 套全绿**（新增 `events.smoke`；`observe.smoke` 重写，含"一次调用"、
  锚点、missingZones、幂等、缺 embedding 仍一次调用、降级、并发等断言）
- 真实模型实测：`mode=merged, llmCalls=1`，五键齐全，`anchored` 观测 2/2、立场 1/1；~17s
- 真实库已迁到 v9（`GET /api/status` → schemaVersion 9）

### 会话体检工具 `check-session.mjs`（仓库根）

跑完一轮真实对话后，用来看"到底织进去了什么"——凭感觉判断质量是不行的：

```bash
node check-session.mjs "<chatId>"                     # 只看库
node check-session.mjs "<chatId>" --context "<查询词>"  # 连注入一起看 (需服务在跑)
```

它输出四类信号：三层产出条数、**锚点命中率**（0% = 模型没填 event 键）、
**同标题重复行**（V9 判等是否生效）、注入里各段实际计数。只读，不改任何数据。

首次实测（用户真实会话 `Seraphina - chat`）：9 观察 / 3 立场 / **0 顶层事件**、
锚点 0%（数据都在合并抽取之前产生），另发现一条诊断残留块 `[诊断] 向量召回诊断测试块`。

## 酒馆前端已冻结（2026-10-14，用户决定）

路线定为 dsh 之后，酒馆前端（`manifest.json` / `index.js` / `settings.html` / `style.css` / `src/`）
**冻结**：不再演进，但**不废弃** —— 仍能装能跑，语义仍由 server 侧保证。

### 冻结约定（README「路线状态」是面向所有人的版本，这里是执行细节）

- 新功能、新语义、新交互**一律只做在 dsh 侧**；冻结区只允许两类改动：
  ① 后端契约变更把它弄坏了 → 修到能跑为止，**不加功能**；
  ② 明确的移植/回填需求，且当次同步更新 README 与本节。
- **后端语义变更时的义务**：冻结区没有人在天天用，坏了不会立刻暴露。所以
  改后端后必须跑 `node check-contract.mjs`（它用前端自己的 `api.js` / `meta.js` 对接真实服务），
  以及 `node check-static.mjs`（冻结守卫：HTML id ↔ JS 选择器 ↔ 默认设置字段）。
- 两个入口脚本按路线分工：
  `启动AIRP模式.bat`（dsh：同步预设 + 起服务 + 开桌面端）、
  `打开酒馆（含记忆服务）.vbs`（酒馆：看门狗 + 开酒馆）。

### 冻结后遗留的一个待决问题

`server/watch-tavern.mjs`（登录自启的看门狗）**把记忆服务的自动拉起绑在 TauriTavern 是否运行**上。
它现在仍是记忆服务的自动拉起者之一，但 dsh 路线下"服务应该在 dsh 启动时拉起"。
目前 `启动AIRP模式.bat` 会自己起服务，所以两条路都能用；要不要把看门狗改成认 dsh、
或干脆让两条路线各自显式起服务，留待决定（**改它会同时影响两条路线，动手前先想清**）。

## 三个真实会话问题的修复（2026-10-14 晚，用户："开始一并修复问题"）

跑完三轮真实对话做体检（`check-session.mjs`）后修掉的三件事：

### ① `main` 唯一不变量（正确性）

**现象**：库里裂出三个"用户本人"（`你` / `User` / `主角`，都是 `person_type='main'`），
立场与画像按节点分家 —— 注入里同时出现 `塞拉菲娜→你 守护` 与 `塞拉菲娜→主角 保护`。

**修法（两层，边界很重要）**：

| 路径 | 行为 | 为什么 |
|---|---|---|
| `findOrCreatePerson({personType:'main'})` | 已有 main 时把新来的**降级为 npc**，不建第二个 | 模型标谁 main 只是它的判断，**不是身份证据**（实测见它把两个不同的人都标成 main；若按"后者并入前者"会并掉一个真实角色） |
| `ensureMainPerson({name})` | 有 main 就把命中节点**并进**它（复用 id），名字入别名 | 只有确定性证据（`userName` 命中）才允许归并；换称呼自动落到同一节点 |
| `mergePersonIntoMain({fromId,toId})` | 重指参与者/立场/观察/引用桥/归属者 → 原节点软删 | 只改引用不删内容；`event_participants` 主键 `(event_id,person_id,role)` 冲突先删重复行 |
| `normalizeStanceSlots()` | 同槽位多条生效 → 保留最新 + 链式 `supersedes` | 指针语义要求同槽位只有一个当前值；注入里显示成 `守护 → 保护` 而不是两行并存 |

既有数据的修复走 CLI：`cd server && npm run merge-mains`（干跑）/ `-- --apply`（执行）。
真实库实测：3 个 main 合成 1 个（`你`，别名 `["User","主角"]`），重指参与者 14 条 + 引用桥 10 条，
2 个立场槽位收口（`守护→庇护→保护` 成链）。

### ② "每轮编织"的自我纠偏：轮次水位提示（nudge）

**现象**：连着三轮只织了一批（20:49:35 一次）—— 内容没漏（窗口滑动覆盖整场戏），
但纪律写的"每轮"名存实亡。

**修法**：适配器（`server/mcp/turnNudge.mjs`）维护 per-chat 计数 ——
每次 `memory_context` 就是"模型开了一轮"，距上次 `memory_observe` 超过阈值
（`MCP_NUDGE.afterContextCalls = 2`）就把一行【记忆编织提醒】**附在该次返回里**。
纠正跟着模型读记忆的动作一起到，不依赖它自己记得纪律，也不需要摸 dsh 的 turn-end 插件 API。

实测（真实适配器 + 真实服务）：第 1 次 `memory_context` 无提示，第 2 次起提示并报积压轮数。

> 另一条更硬的路（**原生插件订阅 `turn.end` 自动触发**，彻底不靠模型）仍待做：
> asar 里确认存在 `turn.start` / `turn.end` 等事件类型字符串，但订阅方式与
> "插件文件必须在 profile 目录旁"这两点还需一轮调研，暂未动手。

### ③ 清理诊断残留

`[诊断] 向量召回诊断测试块`（`attribute_chunks` id 9）**软删**（`is_active=0`，可逆）；
它那段时间留下的 `value_nodes` 词汇节点"诊断"已无生效块引用，一并移除。
（同会话另一条 `向量召回修复验证块` 早已被你软删，未动。）

## 根因修正：纪律必须内联进预设，不能依赖工作区文件（2026-10-14 晚）

用户"又跑了三轮对话"后体检发现：**这三轮一条记忆都没写**（`http.log` 只有
`memory_context` / `memory_list`，没有一次 `memory_observe`），且用的是 `chatId=default`。

### 根因

会话跑在 **`D:\临时` / `E:\色彩`** 这两个工作区（不是 `E:\记忆系统`）。而
`@deepseek-ai/dsh-agent-instructions` 是**按工作区根找指令文件**的
（`projectRootMarkers: ['.git']` + `instructionFileCandidates`，schema 里**没有**全局指令目录的配置项），
那两个目录里既没有 `AIRP.md` 也没有 `.git` ⇒ **纪律文件从未被注入**。
于是模型只有"按需加载的 skill"和一次性 MCP 说明，退回凭自觉：三轮织一次、chatId 随手填。

### 修法：纪律进 system prompt，与工作区无关

```
AIRP.md  ──(sync-profiles.mjs 整份读取)──►  预设 persona.suffix
   （唯一真源，必须保持短）        （= system prompt 常驻部分，任何工作区都在场）
```

- `dsh/airp-preset.patch.yml` 里 suffix 写成占位符 `"@@AIRP_DISCIPLINE@@"`
- `dsh/sync-profiles.mjs` 读 `AIRP.md`（去掉标题与维护者注释），拼上 RP 输出要求后
  以 **JSON 字符串**（合法的 YAML 双引号标量）填进去 —— 免掉 YAML 多行缩进与转义的坑
- 占位符缺失会**直接报错**（纪律静默丢失是最坏的失败模式：看起来一切正常，模型只是不照做）
- `AIRP.md` 顶部因此写明：它会被整份内联，**必须保持短**，长解释放本文件

验证：`dsh --profile airp --dump-config` 零告警，`chatId` / `characterId` / `userName` /
`记忆编织提醒` / `memory_summarize` / 红线 全部出现在 persona suffix 里；
`~/.dsh/profiles/{desktop,airp}/cordis.patch.yml` 两份都带上（旧文件各留 `.bak`）。

### 一个已知取舍（未动）

根层 `system-prompt` 的 `includeHarnessIdentity` 只在 **airp profile** 里设成 false；
**桌面端那份生成块没有设** —— 因为在桌面端它是**根级**配置，改了会连原版会话一起改
（我们承诺不动原版）。结果是 AIRP 会话里仍可能带一句 harness 身份文本，与本预设的 RP 基调并行。
要动的话得接受"原版也会失去那句身份说明"，留待决定。

## 第四次真实对话：纪律全对，但抽取模型整段 502 —— 静默失败与瞬时重试（2026-10-14 深夜）

### 现场

内联纪律生效后，`D:\临时` 又跑了一场新戏（会话档「新国家国门守卫」，`agentPreset=airp-roleplay`，
4 轮）。这一轮**纪律全对**：`chatId=边境国门` 全程固定、`characterName=国门守卫`、
`userName=旅人`、每轮 `memory_observe`（带 `floor-N` 来源）、收尾 `memory_summarize` ——
上一版 `chatId=default` 的问题已经消失。

但库里几乎什么都没落下：

| 表 | 边境国门 |
|---|---|
| `memories` | 1 行（`memory_write` 手写的 summary，id 50）|
| `events` / `attribute_chunks` / `stances` | **0 / 0 / 0** |

对照同一晚 20:49 的「酒馆场景探索」（同一个 `D:\临时`、同为 airp-roleplay）：
`mode=merged`、6 事件 + 2 从句子实例 + 5 观察 + 2 立场全部落库，
`valid_from_event_id` **全部填上**（观察 53/55/59、立场 58/59）——
**跨层锚点的自动路径是通的**，这次失败与抽取逻辑无关。

### 根因：抽取网关整段 502（不是代码错）

```
POST https://gcli.ggchan.dev/v1/chat/completions  →  502  (连 /v1/models 也 502)
POST https://api.siliconflow.cn/v1/embeddings      →  200  (embedding 正常)
```

`observe` 如实降级：`merged` 整份解析失败 → `split-fallback` 三步并行 → 三步各自 502
→ `steps.*.ok=false`。**summary 仍写进去了**，是因为它不需要 LLM。

### 两个设计缺口（本次修复）

**① 顶层 `ok:true` 把"一行没落库"糊过去了。**
单层失败不中断其余层是**有意设计**（一起失败只会丢更多），所以 HTTP 也保持 200；
`OBSERVE_DEGRADE_NOTE` 里写着"判断结果要看 `steps` 与 `mode`, 不能只看顶层 `ok`" ——
但实测模型看见 `ok:true` 就往下走了，这场戏的内容**在无人察觉的情况下永久丢失**。

修法（不破坏现有语义，只加"说实话"的字段 + 一行提示）：

- `observeService.outcomeOf()` 算出 `failedSteps` / `skippedSteps` / `allFailed`
  （`skipped` 如 embedding 不可用**不算失败**，它没打算跑）
- 适配器看到 `allFailed` 就 `MCP_NUDGE.failedHint` 附一行【本轮记忆未落库】，并**不清水位** ——
  于是下一轮读记忆时【记忆编织提醒】会自然再提一次，模型自己用相同 `text` 补跑就完事
- 错误原因只留一行、在第一个 `<` 处截断：网关的错误页是整篇 HTML，塞进上下文既没用又吃 token

**② 一次抖动 = 整轮丢失，因为没有重试。**
每轮编织只有一次调用机会。`llmClient` 原来 5xx 直接抛，加上修法①，最坏情况从"静默丢"变成"说出来但还得丢"。

修法（`LLM_LIMITS` 同源定义）：对 `408/425/429/5xx`、超时（`AbortError`）与网络层错误
重试 `retries=2` 次，退避 `500ms → 1000ms`；**4xx 语义错不重试**（模型名写错重试只是白等）。
实测 502 三连从"整轮丢失"变成"抖过去就好"。

### 验证

- `npm test`：**21 套全绿**（新增 `llm-retry.smoke`：假网关复现"抖两下再成功"、
  4xx 不重试、重试耗尽如实抛错、`retries=0`、连不上；`mcp-nudge.smoke` 加 11 条全层失败断言）
- `check-static.mjs` 通过；`check-contract.mjs` 通过
- 真实链路实测（网关仍在 502 时）：`/api/observe` 返回 `allFailed:true` +
  `failedSteps:["instances","attributes","stances"]`；经 `mcp/index.mjs` 走一遍，
  返回末尾确实带上【本轮记忆未落库】那行，且 `isError:false`（不打断 RP）

### 仍然没有的东西（留给下一版）

- **补织队列**：已经丢的那场戏（`边境国门` 4 个楼层）只剩 summary 一条压缩痕迹。
  现在的自愈是"下一轮记得补"，前提是模型手上还有那段 `text`；跨会话的补织需要落一张"待织"表。
- **抽取模型的冗余**：网关是单点。要不要支持 `llm.fallback`（备用 provider/模型）待定。

## 抽取模型切换到 DeepSeek 官方 + 补织丢失的那场戏（2026-10-14 深夜）

### 换模型

`gcli.ggchan.dev` 是单点且当晚整段 502，换官方：

| 项 | 值 |
|---|---|
| baseUrl | `https://api.deepseek.com/v1` |
| model | `deepseek-flash`（DeepSeek-V4.1-Flash，1M 上下文） |
| timeoutMs | 120000（默认档带推理，大段抽取实测 ~26s，60s 太紧） |

`POST /api/config` 深合并写盘 + 热重建，无需重启；换前留了 `config.json.bak-*`。

### 新增 `llm.extraBody`：供应商私有开关透传

DeepSeek-flash 是推理模型（effort 默认 high）。同一段小文本：默认档 ~10.8s，
`reasoning_effort:"low"` ~1.2s。为不锁死这种调优，`llmClient` 支持
`config.json → llm.extraBody`（对象，**原样合并进请求体、放在最后**，可覆盖默认字段；
不进 HTTP 白名单 = 只能改文件，面板保存不会冲掉它）：

```json
"llm": { "baseUrl": "...", "model": "deepseek-flash", "extraBody": { "reasoning_effort": "low" } }
```

当前**没有**设置它（默认 high）：抽取质量优先，实测大段 26s 与旧 gemini 通道（~17s）同量级。
嫌慢再把 `reasoning_effort` 调成 low，但换档后建议跑一次 `check-session` 对比锚点与产出。

### 补织丢失的 `边境国门`

模型一通就把那场丢掉的戏补回来了：两次 `observe` 原样重放（同 chatId/text/sourceMessageIds，
参数取自 dsh 会话日志里失败的调用）。`check-session 边境国门`：

- 19 条顶层事件 + 5 从句、14 条观察、1 条立场（守卫→你 戒备 0.8）
- **锚点命中 100%**（观察 14/14、立场 1/1）；**无同标题重复行**
- 抽取质量：身份/习惯/性格/氛围分面正确，verb 归一到位（劝告/解牌/命令/试绳/沉默/列位待命），
  世界内时间分组「暮色中，临近戌时三刻落闸」
- 意外的加分验证：floor-1 的 observe 被重复跑了两次，第二次全部走判等 —— 事件 `existed:true, confirms:1`、
  观察走指纹 `operation:update + supersedes + similarity 0.8639`、立场 `operation:confirm`，**零重复行**
  （V9 判等 + V8 属性指纹 + V7 立场槽位三套判等在真实模型下同时生效）

### 验证

`npm test` 21 套全绿（`llm-retry.smoke` 加 extraBody 透传断言）；重启后 `/api/meta` →
`llm.available=true, model=deepseek-flash`，向量召回正常。

## 记忆网络可视化窗口 `GET /graph`（2026-10-14 深夜，用户："做一个事实的二维动态记忆网络的窗口"）

玩 dsh 时在旁边开着看"这场戏织出了什么网"。`启动AIRP模式.bat` 第 4 步会自动开这个窗口；
也可随时手动开 `http://127.0.0.1:7780/graph`。

### 形态选择（为什么是浏览器侧页而不是塞进 App）

- dsh 桌面端是 Electron 独占壳（app.asar 硬编码），往里嵌 UI = 动原版，违背"原版零变化"承诺；
- 记忆服务本来就常驻 7780，**同机浏览器开一个页 = 零新依赖、零构建、不碰 App**；
- dsh 会话里模型自己不开窗（AIRP 预设刻意无 shell），让"窗口"由启动脚本负责最省事。

### 组成

| 件 | 说明 |
|---|---|
| `server/src/services/graphProjection.js` | 只读投影：把"实体-事件异质网络"按 chatId 投成 节点+边。实体边界 = 被边引用过（参与/立场/观察锚点/位置），没被引用的全库实体不进图 |
| `GET /api/graph` | 投影端点。**有意不进 ENDPOINTS 契约**：不参与注入/抽取语义，前端契约也不消费，列进去只会扩大 check-contract 的面 |
| `server/public/graph.html` | 零依赖单文件页（canvas 力导向，无构建） |

### 页面能力

- **五种边图层**：参与（人↔事件）/ 因果（事件→事件，带箭头）/ 位置 / 立场（实体→实体有向，按
  敌对-红 / 保护-绿 / 亲近-蓝 着色，粗细=强度，线标 类型+数值）/ 观察锚点（默认关，开了能看到
  属性块挂在哪个事件上）
- **「仅事实」开关**：隐藏 attributed 述谓实例（角色声称/从句/条件）及其边 —— 与 `v_facts`
  同口径，回应"模糊的东西不进事实视图"
- **「签名视图」开关（默认开，事件折边的最终形态）**：用户定调 —— *event 当作一个标注而不是
  节点容器；事件只作为事件通路（时间·地点·人物·谓词）的标注签名*。事件方点彻底释放（不画、
  不参与力学），通路以**行为枢纽**收缩：`实体 — 行为(verb_type) — 实体`，线上印签名
  `label · 谓词 · 世界时间`（一束多签 = ×N）。释放进网络的子节点：**时间**（time_points，
  靛蓝）与**行为**（verb_type，橙）——从事件内容里拆出来的可复用节点；选中实体侧栏列出
  「通路签名」（邻居 ← 签名束）。关掉开关回到"事件=接缝"的调试视图（方点+因果箭头）
- **⏳ 精确时间（未做，需用户拍板）**：时间点显示"年月日星期+具体时刻"做不到显示层变出来 ——
  库里只有叙事性 label（"暮色中，临近戌时三刻落闸"），没有故事历法。×15 合并是抽取粒度问题
  （同一时刻 label 被 15 个事件复用）。要做须动抽取 prompt（结构化时间字段 + 故事历元锚定，
  涉及结构层冻结区的字段决策）
- **聚焦唤起（单击签名戳点亮通路）**：签名戳可点（命中盒随帧记录）——单击连线上的一枚戳/
  时间节点/「☰ 事件戳」索引条目，该事件通路全亮（行为枢纽+人物+地点+时间），其余淡出到
  alpha 0.1；侧栏给通路详情（签名束/端点/过程结果）；Esc 或点空白取消。设计前提是规整网络的
  "一时间一事件"——当前库还是 ×N 合并（抽取粒度问题），聚焦按事件身份（evKey）精确命中，不受合并影响
- **时间轴回放**：滑杆按事件刻度重演网络生长；▶ 回放按钮自动播放；停在末端 = 直播模式
- **自动刷新**（5s）：玩着玩着新节点自己长出来，旧节点坐标不动（增量合并，不重排）
- 交互：拖节点 / 拖背景平移 / 滚轮缩放 / 悬停提示 / 点选侧栏看详情（别名、立场依据、
  事件过程结果、观察分面）；事件方点 = 未定局(status≠asserted)空心；main 用户金色描边

### 纪律

- `createEvent` 返回 **id 数字**（不是行对象）—— 测试里踩过 `e1.id === undefined` 的坑
- 投影只读、零表变更；实体表是全局的，**会话边界只能靠引用关系划**（这是 `graph.smoke` 第 2/3 条钉死的事）

### 验证

`npm test` **22 套全绿**（新增 `graph.smoke` 17 条：排序刻度 / 实体边界 / 会话隔离 /
观察层开关 / 立场方向与生效过滤）；真实库实测：`边境国门` = 24 事件 + 5 人 + 2 地点，
36 参与边 + 17 因果边 + 1 立场 + 14 观察锚点。

### 黑屏三轮排障记录（为什么这个页面带自诊断）

三段式踩坑，每段都有独立教训：

1. **力导向以原点为中心，而原点映射到画布左上角** → 大半节点在负坐标区被裁掉。
   修：`fitView()` 按包围盒装框；且**只要用户没手动挪过视图（userMoved），每次自动刷新都重装**
   （初始紧簇时 k 会顶到 2x，节点随后被力导向撑出视口——只在首帧装框没用）。
2. **画布尺寸只在脚本加载时取一次** → 预览面板布局未就绪时 canvas 可能 0×0。
   修：ResizeObserver 跟随 stage。
3. **图层键名错位（真凶，最隐蔽）**：`S.layers`/chips 用端点长名（participants/...），
   边对象 kind 是短名（part/cause/loc/stance/obs）→ `visibleEdges()` 恒为空 → 只画探针。
   **不抛错、数据齐、循环活着**，纯靠像素采样才能暴露。

排障基建（保留）：页面每 60s fetch 一个故意 404 的 `/__graph_diag?<状态>` 路径，
index.js 的请求中间件会把整条 URL 落进 `data/http.log` —— **服务端零改动即可远程读
页面状态**（painted 像素采样 / inView / k / bbox / nan / scrub / 帧数）；渲染循环包
try/catch，出错红字亮在状态栏且不死；画布中心探针点已确认后移除。
教训：改这个页面的 JS **不要用 `node -e` 双引号脚本做字符串替换**（bash 会把 `$('x')`
当命令替换执行，写坏文件），一律走 Edit 工具。

## 参考资料

- 仓库：github.com/deepseek-ai/deepseek-harness（MIT，~11.8 万 star，0.2.x alpha）
- 文档：docs/capability-seams.zh.md（服务拓扑）、docs/architecture.zh.md、
  docs/cordis-primer.zh.md、docs/agent-lifecycle.zh.md
- 运行：`npx @deepseek-ai/dsh web`（127.0.0.1:3080）/ headless CLI / Python SDK
