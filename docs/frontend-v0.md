# 前端插件 V0（酒馆扩展）—— 内核闭环

面向 SillyTavern 的本地扩展。V0 只做**内核闭环**：连上本地记忆服务 → 每轮生成前注入记忆 → 按需把对话写成记忆。记忆浏览器 / 遗忘面板等留到 V1。

后端 HTTP 契约见 [`api.md`](./api.md)，其中 §12 `GET /api/meta` 是本文所有"语义"的来源。

---

## 1. 一条硬约束：前端不存语义

前端**不内置**后端的任何语义，包括：

- 枚举项与中文标签（`fact → 事实`、`memories → 记忆`）
- 打分权重与公式、`supersede` 阈值、半衰期
- 生效默认值（topK / token 预算 / 遗忘阈值…）
- 端点能力判断（"有没有配 LLM"）
- 错误文案（一律原样展示服务端返回的 `error`）

全部在运行时从 `GET /api/meta` 取。**连不上服务时显示"未载入契约"并禁用依赖项，不会退回本地硬编码。**

对应实现：

| 前端行为 | 语义来源 |
|---|---|
| 步骤开关的可用性与禁用原因 | `meta.endpoints[].needsLlm / needsEmbedding` + `meta.capabilities.*` |
| `topK` / token 预算输入框的"服务端默认 N"提示 | `meta.defaults.retrieval` |
| 契约面板里的公式、阈值、规则文案 | `meta.scoring` / `meta.thresholds` / `meta.rules` |
| 检索预览里 `fact` 显示成"事实" | `meta.enums.memoryType` |
| 抽取请求的 fetch 超时 | `meta.capabilities.llm.timeoutMs` + 固定余量 |
| 写入报告里的"人物 N / 地点 M" | `meta.enums.entityType` 的 label |

前端唯一保留的本地配置是**服务地址初值**（`http://127.0.0.1:7780`）——连上之前无从获取任何信息，属于无法避免的引导常量。

---

## 2. 目录结构

**仓库根目录就是扩展本身**——`manifest.json` 在根，酒馆才会通过仓库地址直接安装（它只认仓库根的那一份，子目录里的不认）。后端与文档作为同级子目录放在同一个仓库里，酒馆加载扩展时不会碰它们。

```
AIRP-memory/               ← 克隆后就是这个目录，即扩展目录
├── manifest.json          扩展清单 (酒馆读取)
├── index.js               入口: 装配模块、挂载面板、绑定宿主事件
├── settings.html          设置面板模板 (用 import.meta.url 定位, 与目录名无关)
├── style.css              面板样式 (复用酒馆主题变量)
├── check-static.mjs       静态检查: HTML id ↔ JS 选择器 ↔ 默认设置是否对得上
├── check-contract.mjs     契约检查: 用前端自己的 api/meta 对接真实服务
├── src/
│   ├── bus.js             极简事件总线 (避免模块互相 import 成环)
│   ├── log.js             日志 (debug 受开关控制)
│   ├── settings.js        前端偏好 + 引导常量  ← 唯一允许存在的本地配置
│   ├── api.js             HTTP 客户端 (不含任何后端语义)
│   ├── meta.js            /api/meta 的本地镜像  ← 前端一切的语义来源
│   ├── session.js         chatId / characterId 解析 + 对话原文收集
│   ├── injector.js        注入闭环: GENERATION_AFTER_COMMANDS → /api/context
│   ├── extractor.js       写入闭环: 四个抽取端点, 逐步静默降级
│   └── ui.js              设置面板渲染与绑定
│
├── server/                本地记忆服务 (后端, 不被酒馆加载)
├── db/                    表结构与迁移
└── docs/                  设计与接口文档
```

---

## 3. 安装

先把后端跑起来：

```bash
cd server
cp config.default.json config.json    # 填 LLM / embedding 配置
npm start                             # 127.0.0.1:7780
```

然后在酒馆里装扩展：**扩展**（拼图图标）→ **Install extension** → 粘贴仓库地址：

```
https://github.com/Icey0111/AIRP-memory
```

酒馆会用 Git 克隆到 `<SillyTavern>/data/<你的用户名>/extensions/AIRP-memory/`
（在多人实例里也可以选择装到所有用户：`public/scripts/extensions/third-party/`）。
两种位置都会被挂载到 `/scripts/extensions/third-party/`，模块内的相对导入因此保持一致。

> 目录名**无关紧要**：面板模板用 `import.meta.url` 定位，`extension_settings` 的存储键在
> `src/settings.js` 里固定。克隆得到的文件夹名默认为仓库名 `AIRP-memory`，改名也能正常加载。

重启酒馆 → 打开 **扩展设置** 抽屉 → 找到「记忆系统」。首次打开会自动请求 `/api/meta`，顶部横幅显示连接结果。

### 跨域

酒馆页面（默认 `http://localhost:8000`）与记忆服务不同源。服务端已内置最小 CORS：放行 `localhost` / `127.0.0.1` / `[::1]` 的**任意端口**。若酒馆挂在别的源（反向代理、局域网域名），把它加进 `server/config.json`：

```json
{ "server": { "cors": { "enabled": true, "origins": ["http://192.168.1.5:8000"] } } }
```

---

## 4. 设置项

| 分组 | 项 | 说明 |
|---|---|---|
| 连接 | 服务地址 | 默认 `http://127.0.0.1:7780`，改动后自动重新拉契约 |
| 注入 | 启用注入 | 关掉则完全不注入，也不请求 `/api/context` |
| 注入 | 注入位置 / 深度 / 角色 | 主提示词 `IN_PROMPT` 或对话历史内 `IN_CHAT`（深度仅后者生效）；角色 `system`/`user`/`assistant` |
| 注入 | topK / token 预算 | **填 0 = 用服务端默认**，输入框会显示服务端当前生效值 |
| 注入 | 查询取最近 N 条 / 字数上限 | 拼成检索 query 的原文范围 |
| 写入 | 自动写记忆 | 默认**关**。开启后每 N 条角色消息触发一轮 |
| 写入 | 取最近 N 条 / 字数上限 | 交给抽取端点的对话原文范围 |
| 写入 | 参与写入的步骤 | 四个抽取步骤各自开关；不可用时开关会**禁用并显示原因** |
| 手动 | 立即抽取并写入 | 手动跑一轮写入 |
| 手动 | 检索预览 | 跑一次 `/api/context` + `/api/retrieve`，列出命中（含类型标签与分数） |
| 诊断 | 自检并载入契约 | 重新拉 `/api/meta` + `/api/status` |
| 诊断 | 契约 / 端点能力 / 最近状态 | 全部为服务端原文或本地运行时事实 |

---

## 5. 行为

### 5.1 注入时序

```
GENERATION_AFTER_COMMANDS (dryRun 为真时跳过)
  → 取最近 N 条消息拼 query
  → POST /api/context { query, chatId, characterId }
  → setExtensionPrompt(注入文本)
```

- 新一轮生成到来时**取消**上一次未完成的请求，避免旧结果覆盖新结果。
- `CHAT_CHANGED` 时撤下注入、重置写入计数（记忆本身按 `chatId` 隔离，无需清库）。
- **失败即降级**：注入失败只清掉本轮注入 + 记一条 warn，绝不打断生成。

### 5.2 写入时序

```
（自动：每 N 条角色消息  /  手动：点按钮）
  → 取最近 N 条对话原文 + 楼层号
  → POST /api/extract              六要素（人物/地点/时间点/事件/因果边）
  → POST /api/extract-attributes   属性观察
  → POST /api/extract-stances      立场
  → POST /api/profiles-derive      画像重归纳（用六要素结果里的人物 id）
```

- **每一步独立**：某步失败只跳过该步（记 warn 并在面板标红），其余照常执行。
- 画像重归纳需要 `personId`（`people` 表的**整数** id），只能从当轮六要素结果里按角色卡名匹配得到。匹配不到就**如实跳过**，不猜 id。
- 因为 `chatId` / `characterId` 由前端自动提供，写入端点不需要手动填。

### 5.3 id 口径（容易踩）

| 用途 | 取值 |
|---|---|
| `/api/context` 的 `chatId` | 酒馆 chat 文件名（去扩展名），即 `context.chatId` |
| `/api/context`、`profiles` 的 `characterId` | 角色卡名字符串 |
| `profiles-derive` 的 `personId` | `people` 表整数 id |

后端有两套 id 体系，前两行是字符串、第三行是整数，不可混用（见 `api.md` §11.5）。

---

## 6. 开发校验

两个脚本都在仓库根目录，用 `import.meta.url` 定位自己的同级文件，不需要酒馆环境：

```bash
# 1) 静态一致性: HTML 的 id ↔ JS 的选择器 ↔ DEFAULT_SETTINGS 的字段是否对得上
node check-static.mjs

# 2) 契约一致性: 用前端自己的 api.js / meta.js 对接真实服务
#    (先启动后端; 校验 canCall 与声明逐条一致、标签取自服务端、超时由服务端推算、
#     以及服务不可达时不退回硬编码)
node check-contract.mjs [baseUrl]
```

后端侧对应的是：

```bash
cd server && npm test     # extract / chunks / stances / routes / meta 五套
```

其中 `test/meta.smoke.js` 专门钉死"前后端语义一致"：meta 的枚举权重必须与 `domain/constants.js` 同源、声明的每个端点必须真实存在、`needsLlm/needsEmbedding` 标记必须与实测行为一致、声明 `degrade=silent` 的端点在"embedding 客户端存在但未配置"时确实不报错。

---

## 7. V1 待办

- 记忆浏览器：一阶记忆 / 画像 / 观察块 / 立场的列表与增删改（`GET /api/memories`、`/api/profiles/:characterId`、`/api/chunks`、`/api/stances`）
- 遗忘任务面板：`POST /api/forget` 干跑候选 → 确认执行 → `POST /api/forget/restore` 恢复
- 手动新建记忆的表单（用 `meta.enums` 渲染 `type` / `scope` 下拉）
- 注入内容在聊天界面的可视化标记（哪几条进了 prompt）
- 抽取结果跳转到源楼层
