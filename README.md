# AIRP Memory —— 酒馆记忆系统

给 SillyTavern（酒馆）角色扮演用的**长期记忆**扩展，自带一套本地记忆服务。
记忆分三层沉淀（事实/事件/摘要 → 述谓实例语义图 → 属性观察向量 → 关系立场），
并带一层**命题层**记录"被言及但尚未发生"的内容（承诺/意图/威胁），
随剧情演化而不"吃书"，遗忘可逆。

- **本地优先**：记忆库是一个 SQLite 文件，服务跑在 `127.0.0.1`，不出网。
- **前端零语义**：扩展不内置任何枚举、权重、默认值、错误文案，全部运行时从
  `GET /api/meta` 取；连不上服务就显示"未载入契约"并禁用相关按钮，**不退回本地硬编码**。
- **静默降级**：注入或抽取失败只记一条 warn，绝不打断你的对话。

> 设计主线（V6）：**存原语与边，其余都是视图** —— 事件是簇、摘要是路径压缩、
> 通路编号是坐标、待兑现清单是未决命题视图。见 `docs/verb-layer.md`。

> 本仓库根目录即为酒馆扩展本体（含 `manifest.json`），因此可以直接用仓库地址在酒馆里安装。

---

## 快速开始

### 1. 启动记忆服务

```bash
cd server
npm install
cp config.default.json config.json     # 也可以不手动编辑: 面板"连接与能力"里有模型配置表单
                                       # (密钥输完即遮显, 只发往服务端落盘, 保存后热生效无需重启)
npm start                              # 127.0.0.1:7780
```

不填配置也能启动：只有抽取/向量类端点不可用，扩展面板会把不可用的步骤**禁用并显示原因**。
想先离线试用，把 `config.json` 里的 `llm.provider` / `embedding.provider` 都设为 `"mock"` 即可。

### 2. 在酒馆里安装本扩展

打开酒馆 → 顶部 **扩展**（拼图图标）→ **Install extension** → 粘贴：

```
https://github.com/Icey0111/AIRP-memory
```

点击安装，刷新页面。扩展会以 `AIRP-memory` 为文件夹名落在你的扩展目录里。

<details>
<summary>手动安装方式</summary>

把本仓库克隆进酒馆的扩展目录（二选一）：

```bash
# 仅当前用户
git clone https://github.com/Icey0111/AIRP-memory <SillyTavern>/data/<你的用户名>/extensions/AIRP-memory

# 所有用户
git clone https://github.com/Icey0111/AIRP-memory <SillyTavern>/public/scripts/extensions/third-party/AIRP-memory
```

文件夹名可以随便取（模板用 `import.meta.url` 定位），重启酒馆即可。
</details>

### 3. 打开面板

酒馆 → **扩展设置**抽屉 → 找到「**记忆系统 (Memory)**」。首次打开会自动请求 `/api/meta`，
顶部横幅会显示连接结果；连上了就能看到服务端下发的枚举、打分口径与能力状态。

> **跨域**：酒馆页面与记忆服务不同源，服务端已内置最小 CORS，放行 `localhost` /
> `127.0.0.1` / `[::1]` 的任意端口。若酒馆挂在别的源（反向代理、局域网域名），
> 把它加进 `server/config.json` 的 `server.cors.origins`。

### 手机 / 局域网访问

服务默认只监听本机（`127.0.0.1`）。手机浏览器访问电脑上的酒馆时，前端跑在手机上，
要连的是**电脑**的记忆服务，做三件事：

1. `server/config.json` 改两处：
   - `server.host` 设为 `"0.0.0.0"`（监听局域网）；
   - `server.token` 设一个随机字符串（**必设**——不设令牌就暴露局域网等于公开记忆库，服务启动时会警告）
2. `server.cors.origins` 加上酒馆页面的源（如 `http://192.168.x.x:8000`）
3. 手机端面板里：服务地址填 `http://<电脑局域网IP>:7780`，**访问令牌**填第 1 步的值

令牌是「进门的钥匙」，可随时改掉撤销；上游 API key 仍然只在电脑端的服务里，手机端不碰。
安全模型见 `docs/frontend-v0.md`。

### 不在同一局域网（出门在外）

关键认知：**记忆服务不需要跟着手机走，只需要跟着酒馆服务端走**。
手机既然能打开酒馆，就说明已有一条通往酒馆服务端的通路——让记忆服务搭同一班车即可：

| 你的酒馆部署方式 | 记忆服务怎么放 |
|---|---|
| 酒馆跑在公网 VPS / NAS（手机直接输域名访问） | 把 `server/` 也部署到同一台机器，绑定 `0.0.0.0` + **必设 `server.token`**；手机面板填 `https://你的域名:7780`（或反代路径）+ 令牌 |
| 酒馆跑在家里电脑，靠 Tailscale / ZeroTier 出门访问 | 两端装上后**永远在同一张虚拟局域网**，不需要公网 IP：服务 `host` 绑 `0.0.0.0` + token，手机面板填电脑的虚拟 IP（如 `http://100.x.x.x:7780`） |
| 酒馆靠 cloudflared / frp 内网穿透 | 最简单是给 7780 也开一条隧道（同一工具），**令牌必设**；用 cloudflared 时建议叠 Cloudflare Access |
| 标准版 SillyTavern（Node 服务端） | 进阶做法：写一个 ST server 插件把 `/api/tm/*` 反代到 `127.0.0.1:7780`——记忆服务保持只听回环，手机只走酒馆自己的通路，零新增暴露面 |

共同底线：**只要服务离开回环，`server.token` 就不是可选项**；令牌可随时更换撤销。

> 提示：记忆服务是独立的 Node 进程（`cd server && npm start`），与酒馆本体无关。
> TauriTavern 用户即使系统没装 Node，也可以直接用 TauriTavern 自带的 Node 运行时来启动它。

---

## 怎么用

面板里的开关按"注入 / 写入 / 总结"三组：

| 分组 | 做什么 |
|---|---|
| **注入** | 每轮生成前把相关记忆拼进 prompt（`/api/context`）。可设注入位置、深度、角色、topK、token 预算、前情提要预算 |
| **写入** | 把对话沉淀成记忆。默认**关闭**；开启后每 N 条角色消息自动跑一轮，也可随时手动触发 |
| **总结** | 长对话压缩。未总结正文累计到阈值（默认 **10 层楼**）→ 压成一条摘要记忆 → 隐藏被覆盖的正文。默认**关闭** |
| **手动** | 「立即抽取并写入」「检索预览」——后者能看到实际会注入的【前情提要】整段，以及命中了哪几条记忆、各自分数 |
| **诊断** | 重新拉契约、查看端点能力与最近一次运行状态 |

面板按模块分组、可折叠（标题右侧带一行状态摘要），面板本体限高、超出部分内部滚动，不会把酒馆设置抽屉拉得很长；折叠状态会连同其他偏好一起记住。面板里的改动**即时持久化**（存进酒馆自己的设置文件，无需保存按钮），「重置前端设置」只重置扩展偏好、不动记忆数据。扩展**不保存任何密钥**——API Key 只存在于后端 `server/config.json`（已排除出版本库）。

写入是四步流水线，**每步独立、失败只跳过该步**：

```
对话原文 → 六要素（人物/地点/时间点/事件/因果边）
        → 属性观察（向量化，同维度相似时自动建立覆盖链，防止"吃书"）
        → 关系立场（有向、带强度，可演化）
        → 画像重归纳（由当前生效的观察块归纳出常驻画像）
```

长对话另有**总结**这一路（与前四步独立）：未总结正文累计到 **10 层楼**（默认，用户消息与角色消息各占一层）时，
把它压成一条 `type=summary` 的记忆，并把已被覆盖的正文用酒馆原生的 `/hide` 隐藏 ——
隐藏只是移出 prompt，**不删除、随时可放回**。触发楼层数、单批安全阀、摘要长度上限、保留楼层数全部由
`/api/meta` 下发，前端不写死。之所以按楼层而不按 token，见 [`docs/summarization.md` §2](docs/summarization.md)。

注入进 prompt 的内容因此是四段：**角色画像 → 前情提要 → 相关记忆 → 相关细节**。
第二段【前情提要】是按楼层顺序拼起来的摘要链 —— 它**不参与相似度检索**：正文既然已经被隐藏，
摘要就是那段剧情唯一的载体，靠相似度去碰运气只会让它在关键词不命中时整段消失。
它走独立预算（默认 2000 token），与检索预算互不挤占。详见
[`docs/summarization.md` §5](docs/summarization.md)。

---

## 目录结构

```
AIRP-memory/                  酒馆扩展本体（仓库根 = 扩展根）
├── manifest.json             扩展清单，酒馆读它来加载
├── index.js                  入口：装配模块、挂载面板、绑定宿主事件
├── settings.html             设置面板模板
├── style.css                 面板样式（复用酒馆主题变量）
├── src/
│   ├── settings.js           前端偏好 + 服务地址引导常量（唯一允许存在的本地配置）
│   ├── api.js                HTTP 客户端（不含任何后端语义）
│   ├── meta.js               /api/meta 的本地镜像 —— 前端一切的语义来源
│   ├── session.js            chatId / characterId 解析、对话区间收集、隐藏楼层、per-chat 状态
│   ├── injector.js           生成前注入闭环
│   ├── extractor.js          写入闭环（四个抽取端点，逐步静默降级）
│   ├── summarizer.js         总结闭环（累计楼层 → 压缩 → 隐藏已总结正文）
│   ├── ui.js                 设置面板渲染与绑定
│   ├── bus.js / log.js       事件总线、日志
├── check-static.mjs          静态一致性检查（不需要酒馆）
├── check-contract.mjs        契约一致性检查（对着真实服务跑）
├── make-panel-preview.mjs    生成面板离线预览页（看排版，不需要酒馆）
│
├── server/                   本地记忆服务（Node + Express + better-sqlite3）
│   ├── src/api/              HTTP 层：routes / meta 契约端点 / cors
│   ├── src/services/         业务层：写入、抽取、检索、画像、立场、总结、前情提要、遗忘
│   ├── src/domain/           constants.js —— 全项目唯一语义源
│   ├── test/                 七套冒烟测试
│   └── config.default.json   配置模板
│
├── db/                       表结构与迁移（schema.sql + migrations/001~004）
└── docs/                     设计与接口文档
```

---

## 为什么前端没有硬编码

这是本项目的一条硬约束，也是它和多数扩展不一样的地方：

```
server/src/domain/constants.js        ← 唯一定义处（枚举+标签、权重+公式、阈值、默认值、总结策略、能力矩阵）
        ↓ 派生
GET /api/meta                         ← 前后端唯一契约
        ↓ 运行时载入
前端 src/meta.js                      ← 镜像；未载入时所有访问器返回 null，调用方必须显式处理
```

服务端内部（memoryService / retrievalService / forgetService / chunkService / summaryService …）也都 `import`
同一份常量，所以**面板上展示的语义**与**后端实际执行的语义**是同一份数据，不会漂移。

这条约束由测试钉死，不靠人工对齐：

- `server/test/meta.smoke.js`：meta 的枚举/权重必须与 `domain/constants.js` 同源；声明的每个端点必须
  真实存在；`needsLlm` / `needsEmbedding` 标记必须与实测行为逐条一致；声明 `degrade=silent` 的端点
  在"客户端存在但未配置"时确实不报错；CORS 的放行与拒绝。
- `check-contract.mjs`：用前端自己的 `api.js` / `meta.js` 对接真实服务，校验 `canCall` 与声明逐条
  一致、标签取自服务端、超时由服务端推算、服务不可达时一律不可用。

---

## 开发校验

```bash
# 后端（七套冒烟测试，用内存库，不污染本地数据）
cd server && npm test

# 前端静态一致性：HTML 的 id ↔ JS 选择器 ↔ 默认设置字段是否对得上（不需要酒馆）
node check-static.mjs

# 前端契约一致性：先启动后端，再跑
node check-contract.mjs [baseUrl]        # 默认 http://127.0.0.1:7780
```

## 文档

| 文档 | 内容 |
|---|---|
| [`docs/api.md`](docs/api.md) | HTTP 契约全量说明；§12 是 `GET /api/meta` 契约描述，§13 是 `POST /api/summarize` |
| [`docs/summarization.md`](docs/summarization.md) | 长对话怎么总结：多少层一次、**为什么不用 token**、隐藏正文的机制与取舍、**摘要如何回到 prompt（【前情提要】, §5）** |
| [`docs/frontend-v0.md`](docs/frontend-v0.md) | 扩展的安装、设置项、注入/写入/总结时序、id 口径 |
| [`docs/database-design-v1.md`](docs/database-design-v1.md) ~ [`v4`](docs/database-design-v4.md) | 结构层设计演进（一阶记忆 → 六要素 → 属性向量 → 立场） |

## 许可

仅供个人使用与学习。使用第三方扩展前请自行确认来源可信。
