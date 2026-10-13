-- ============================================================
-- 酒馆 AIRP 记忆系统 - 数据库结构 V1
-- 目标数据库: SQLite 3.35+ (需启用 FTS5)
-- 说明: 本文件为 V1 首个可执行版本, 仅定义数据结构,
--       不含检索打分 / 向量 / 遗忘任务的实现逻辑.
-- ============================================================

PRAGMA journal_mode = WAL;
PRAGMA foreign_keys = ON;

-- ------------------------------------------------------------
-- meta: 元信息表 (schema 版本号, 供未来迁移用)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS meta (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
);

INSERT INTO meta (key, value) VALUES ('schema_version', '8')
ON CONFLICT (key) DO UPDATE SET value = '7';

-- ------------------------------------------------------------
-- memories: 核心记忆表
--
-- type 三类:
--   fact    - 事实/设定类记忆 (如 "主角是左撇子", "酒馆老板讨厌精灵")
--   event   - 事件类记忆 (剧情中发生的事, 如 "两人在暴雨夜第一次相遇")
--   summary - 摘要类记忆 (一段对话/一个剧情节点的压缩摘要)
--
-- scope 三个作用域:
--   character - 绑定某个角色, 该角色的所有聊天都可见
--   chat      - 绑定单条聊天/分支, 仅当前聊天可见
--   global    - 全局世界观记忆, 所有角色所有聊天可见
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memories (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 内容与分类
    type              TEXT NOT NULL
                      CHECK (type IN ('fact', 'event', 'summary')),
    content           TEXT NOT NULL,
    keywords          TEXT NOT NULL DEFAULT '',      -- 空格分隔关键词, 供 FTS 加权

    -- 权重属性 (检索打分与遗忘衰减的原料)
    importance        REAL NOT NULL DEFAULT 0.5
                      CHECK (importance BETWEEN 0 AND 1),   -- 重要度 0~1
    emotional_weight  REAL NOT NULL DEFAULT 0
                      CHECK (emotional_weight BETWEEN 0 AND 1), -- 情绪强度 0~1

    -- 作用域
    scope             TEXT NOT NULL DEFAULT 'chat'
                      CHECK (scope IN ('character', 'chat', 'global')),
    character_id      TEXT,                          -- 酒馆角色标识 (scope=character 时必填)
    chat_id           TEXT,                          -- 酒馆聊天/分支标识

    -- 溯源
    source_message_ids TEXT NOT NULL DEFAULT '[]',   -- JSON 数组, 来源消息 id 列表
    in_world_time     TEXT,                          -- 剧情内时间, 自由文本 (如 "第三夜, 暴雨")

    -- 预留字段 (V1 不写, 为向量检索留位)
    embedding         BLOB,
    embedding_model   TEXT,                          -- 生成该向量的模型标识, 换模型时区分重算范围

    -- 遗忘/衰减机制所需的统计字段
    access_count      INTEGER NOT NULL DEFAULT 0,    -- 被检索命中的次数
    is_active         INTEGER NOT NULL DEFAULT 1,    -- 0=已"遗忘"(软删除, 不物理删)

    -- 时间戳 (Unix 秒)
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL,
    last_accessed_at  INTEGER
);

-- 检索主路径索引: 按作用域+角色/聊天过滤, 按重要度/最近访问排序
CREATE INDEX IF NOT EXISTS idx_memories_scope
    ON memories (scope, character_id, chat_id, is_active);
CREATE INDEX IF NOT EXISTS idx_memories_importance
    ON memories (importance DESC);
CREATE INDEX IF NOT EXISTS idx_memories_last_accessed
    ON memories (last_accessed_at DESC);

-- ------------------------------------------------------------
-- memories_fts: 全文检索虚表 (FTS5, 外部内容模式, 不重复存数据)
-- 覆盖 content + keywords, keywords 单独一列可加权
-- ------------------------------------------------------------
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content,
    keywords,
    content = 'memories',
    content_rowid = 'id',
    tokenize = 'unicode61'      -- 如需中文分词, 后续可换 jieba/simple 分词器
);

-- 同步触发器: 保持 FTS 与主表一致
CREATE TRIGGER IF NOT EXISTS trg_memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts (rowid, content, keywords)
    VALUES (new.id, new.content, new.keywords);
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content, keywords)
    VALUES ('delete', old.id, old.content, old.keywords);
END;

CREATE TRIGGER IF NOT EXISTS trg_memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts (memories_fts, rowid, content, keywords)
    VALUES ('delete', old.id, old.content, old.keywords);
    INSERT INTO memories_fts (rowid, content, keywords)
    VALUES (new.id, new.content, new.keywords);
END;

-- ------------------------------------------------------------
-- memory_tags: 记忆标签 (多值, 用于主题归类/人工筛选)
-- 如: "战斗", "感情线", "NPC", "物品"
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_tags (
    memory_id INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    tag       TEXT NOT NULL,
    PRIMARY KEY (memory_id, tag)
);

CREATE INDEX IF NOT EXISTS idx_memory_tags_tag ON memory_tags (tag);

-- ------------------------------------------------------------
-- memory_links: 记忆之间的关联边
-- relation 常用值:
--   related     - 一般相关
--   caused      - 因果 (from 导致 to)
--   supersedes  - 更新替代 (新事实覆盖旧事实, 处理设定矛盾)
--   contradicts - 存在矛盾 (标记冲突, 供人工或后续逻辑处理)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_links (
    from_id   INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    to_id     INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    relation  TEXT NOT NULL DEFAULT 'related',
    weight    REAL NOT NULL DEFAULT 1.0,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, relation),
    CHECK (from_id <> to_id)
);

-- ------------------------------------------------------------
-- character_profiles: 角色记忆画像 (结构化键值)
-- 存"关于某角色的长期稳定设定", 与 memories 的叙述性记忆互补
-- category 建议值: personality / relationship / preference / appearance / state
-- 例: (character_id=艾拉, category=relationship, key=对主角的态度, value=戒备中带好奇)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS character_profiles (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    character_id TEXT NOT NULL,
    category     TEXT NOT NULL,
    key          TEXT NOT NULL,
    value        TEXT NOT NULL,
    -- V3 新增: 该画像条目由哪些观察块归纳而来 (JSON 数组 of chunk id)
    -- 空数组 = 人工填写或早期数据; 非空 = 可溯源到三阶观察块
    derived_from_chunk_ids TEXT NOT NULL DEFAULT '[]',
    updated_at   INTEGER NOT NULL,
    UNIQUE (character_id, category, key)
);

CREATE INDEX IF NOT EXISTS idx_profiles_character
    ON character_profiles (character_id, category);

-- ------------------------------------------------------------
-- retrieval_log: 检索日志 (V1 可选表, 建议建)
-- 记录每次检索的命中情况, 是后续调权重、做遗忘机制的数据基础
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS retrieval_log (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    query          TEXT NOT NULL,
    chat_id        TEXT,
    hit_memory_ids TEXT NOT NULL DEFAULT '[]',   -- JSON 数组: 命中的 memory id
    scores         TEXT NOT NULL DEFAULT '{}',   -- JSON 对象: {memory_id: score}
    created_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_retrieval_log_time ON retrieval_log (created_at DESC);

-- ============================================================
-- V2: 语义实体层 —— 事件六要素模型
-- 模型: 以"事件"为枢纽的实体图
--   人物(people) ──┐
--   时间(time_points) ──┤
--   地点(locations) ──┴──► events (起因/过程/结果)
--   事件之间再通过 event_links 构成因果链
-- ============================================================

-- ------------------------------------------------------------
-- people: 人物实体表
-- 剧情中出现的所有人, 与酒馆的"角色卡"解耦:
--   主角、NPC、仅被提及的人物, 都在这里统一管理
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS people (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,                     -- 主称呼
    aliases      TEXT NOT NULL DEFAULT '[]',        -- JSON 数组: 别名/绰号, 归并与检索用
    person_type  TEXT NOT NULL DEFAULT 'npc'
                 CHECK (person_type IN ('main', 'npc', 'mentioned')),
    description  TEXT NOT NULL DEFAULT '',          -- 人物速写 (可由画像表补充)
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (name)
);

-- ------------------------------------------------------------
-- locations: 地点表
-- parent_id 支持层级: 王国 > 城市 > 街区 > 酒馆 > 大厅
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS locations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',         -- JSON 数组: 别名
    parent_id   INTEGER REFERENCES locations (id) ON DELETE SET NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations (parent_id);

-- ------------------------------------------------------------
-- time_points: 剧情时间点表
-- RP 剧情时间通常是模糊文本 ("第三夜, 暴雨"), 无法解析成真实日期,
-- 因此采用: 自由文本 label + 同一条聊天内的排序序号 seq
-- 时间线按聊天隔离 (不同分支各自一条时间线)
-- parent_id 支持嵌套: 某个夜晚属于某一章
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS time_points (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    label      TEXT NOT NULL,                       -- 如 "第三夜, 暴雨"
    seq        INTEGER NOT NULL DEFAULT 0,          -- 时间线内排序, 越大越晚
    parent_id  INTEGER REFERENCES time_points (id) ON DELETE SET NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (chat_id, label)
);

CREATE INDEX IF NOT EXISTS idx_time_points_chat_seq
    ON time_points (chat_id, seq);

-- ------------------------------------------------------------
-- events: 事件表 (语义层的枢纽)
-- 六要素映射:
--   人物 -> event_participants (多对多, 带角色)
--   时间 -> time_id
--   地点 -> location_id
--   起因 -> cause_text (叙述) + event_links('caused') (指向前置事件)
--   过程 -> process (正文)
--   结果 -> result_text (叙述) + event_links('led_to') (指向后续事件)
-- 与 V1 衔接: memory_id 指向 events 抽取来源的那条 event 类记忆
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT NOT NULL,                -- 事件短标题, 如 "酒馆初遇"
    process           TEXT NOT NULL DEFAULT '',     -- 过程/经过叙述
    cause_text        TEXT NOT NULL DEFAULT '',     -- 起因叙述
    result_text       TEXT NOT NULL DEFAULT '',     -- 结果叙述

    time_id           INTEGER REFERENCES time_points (id) ON DELETE SET NULL,
    location_id       INTEGER REFERENCES locations (id) ON DELETE SET NULL,

    -- ---- V6: 动词槽 (述谓实例的原语, docs/verb-layer.md) ----
    -- 归一用 verb_type (受控词表建议值), 原文永不丢用 verb_surface
    verb_type         TEXT NOT NULL DEFAULT '',
    verb_surface      TEXT NOT NULL DEFAULT '',

    -- ---- V6: 命题三轴 + 极性 + 嵌套 + 对齐指针 ----
    -- 极性: 参与对齐 (命题 ¬P 匹配到事实 P => 「被推翻」, 不是「兑现」)
    polarity          TEXT NOT NULL DEFAULT '+' CHECK (polarity IN ('+', '-')),
    -- 轴②担保来源: 叙述者断言(事实层) / 归属给某人(命题层); 默认 narrator 使旧数据零漂移
    source_type       TEXT NOT NULL DEFAULT 'narrator'
                      CHECK (source_type IN ('narrator', 'attributed')),
    source_person_id  INTEGER REFERENCES people (id) ON DELETE SET NULL,
    attitude          TEXT,                        -- 说/认为/相信/希望/怀疑/假装/不知
    -- 轴①时态定位: 只决定"到没到点", 与来源正交
    tense             TEXT NOT NULL DEFAULT 'past' CHECK (tense IN ('past', 'now', 'future')),
    -- 轴③对齐状态: asserted|pending|realized|failed|inactive|refuted|voided
    status            TEXT NOT NULL DEFAULT 'asserted',
    aligned_instance_id INTEGER REFERENCES events (id) ON DELETE SET NULL,
    -- 嵌套引述: comp(命题宾语) / cond(条件前件) / alt(择一候选), 深度上限 2 (应用层)
    parent_instance_id  INTEGER REFERENCES events (id) ON DELETE CASCADE,
    parent_role       TEXT,

    -- 作用域: 事件总是发生在某条聊天/分支里
    chat_id           TEXT NOT NULL,

    -- 与 V1 memories 的衔接与溯源
    memory_id         INTEGER REFERENCES memories (id) ON DELETE SET NULL,
    source_message_ids TEXT NOT NULL DEFAULT '[]',  -- JSON 数组

    -- 权重 (与 V1 同口径, 检索打分复用)
    importance        REAL NOT NULL DEFAULT 0.5
                      CHECK (importance BETWEEN 0 AND 1),
    emotional_weight  REAL NOT NULL DEFAULT 0
                      CHECK (emotional_weight BETWEEN 0 AND 1),

    is_active         INTEGER NOT NULL DEFAULT 1,
    created_at        INTEGER NOT NULL,
    updated_at        INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_events_chat       ON events (chat_id, is_active);
CREATE INDEX IF NOT EXISTS idx_events_time       ON events (time_id);
CREATE INDEX IF NOT EXISTS idx_events_location   ON events (location_id);
CREATE INDEX IF NOT EXISTS idx_events_importance ON events (importance DESC);
-- V6: 动词层 / 命题层的查询路径
CREATE INDEX IF NOT EXISTS idx_events_verb    ON events (verb_type);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events (status, chat_id);
CREATE INDEX IF NOT EXISTS idx_events_source  ON events (source_type);
CREATE INDEX IF NOT EXISTS idx_events_parent  ON events (parent_instance_id);
CREATE INDEX IF NOT EXISTS idx_events_aligned ON events (aligned_instance_id);

-- ------------------------------------------------------------
-- event_participants: 事件-人物参与关系 (多对多, 带角色)
-- role 建议值: 发起者 / 参与者 / 对象 / 受害者 / 目击者 / 提及
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_participants (
    event_id  INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT '参与者',
    PRIMARY KEY (event_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS idx_event_participants_person
    ON event_participants (person_id);

-- ------------------------------------------------------------
-- event_links: 事件间有向关系 (因果链)
--   caused   - from 是 to 的起因
--   led_to   - from 的结果是 to (与 caused 互为反向表述)
--   preceded - from 在时间上先于 to (顺序补全用)
--   contradicts - 两事件叙述存在矛盾
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS event_links (
    from_id    INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    relation   TEXT NOT NULL
               CHECK (relation IN ('caused', 'led_to', 'preceded', 'contradicts',
                                   'conditional', 'alternative')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, relation),
    CHECK (from_id <> to_id)
);

-- ------------------------------------------------------------
-- memory_entity_refs: V1 记忆 与 V2 实体 的引用桥
-- 一条 fact/summary 记忆提到哪些人、哪些地点、关联哪些事件,
-- 检索时可从记忆跳到实体, 也可从实体反查所有相关记忆
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS memory_entity_refs (
    memory_id   INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL
                CHECK (entity_type IN ('person', 'location', 'event', 'item', 'org')),
    entity_id   INTEGER NOT NULL,
    PRIMARY KEY (memory_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entity_refs_entity
    ON memory_entity_refs (entity_type, entity_id);

-- ============================================================
-- V3: 三阶语义层 —— 属性与元素 (向量层)
-- 原则:
--   1) 向量只做索引, 原文一字不删 (存取分离)
--   2) 双层: attribute_chunks 全量观察块 (按需检索)
--           + character_profiles 生效画像 (由块归纳, 常驻 prompt)
--   3) 向量检索 V1 实现为内存暴力余弦, 量级大了再切 sqlite-vec
-- ============================================================

-- ------------------------------------------------------------
-- attribute_chunks: 属性观察块
-- 细粒度原文观察, 一条一块, 如:
--   "艾拉嘴上嘲讽, 但主角遇险时会下意识挡在前面"
-- 实体锚点 (entity_type + entity_id) 指向 people / locations
-- 时效性: valid_from/to 生效区间 + supersedes_chunk_id 覆盖链, 防"吃书"
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS attribute_chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 实体锚点: 这条观察属于谁/哪个地点
    entity_type    TEXT NOT NULL
                   CHECK (entity_type IN ('person', 'location', 'item', 'org')),
    entity_id      INTEGER NOT NULL,

    -- 维度: personality/appearance/speech/habit/relationship/scene/atmosphere...
    -- 不做 CHECK 约束, 保持可扩展, 建议值见设计文档
    aspect         TEXT NOT NULL,

    -- 原文观察, 一字不删; embedding 只是它的检索指纹
    content        TEXT NOT NULL,
    embedding      BLOB,                          -- Float32 数组序列化; 写入方负责
    embedding_model TEXT,                         -- 生成该向量的模型标识, 换模型时区分重算范围

    -- 时效性 (防吃书)
    valid_from_event_id INTEGER REFERENCES events (id) ON DELETE SET NULL,
    valid_to_event_id   INTEGER REFERENCES events (id) ON DELETE SET NULL,
    supersedes_chunk_id INTEGER REFERENCES attribute_chunks (id) ON DELETE SET NULL,

    -- V8: 重述判定 (与立场层的 confirms 对称, 机制见 docs/verb-layer.md §16.10)
    --   confirms             规范化后文本相同的重复观察次数; 重述**不新增行**, 只累加
    --   supersede_similarity 该行与前驱的余弦相似度, 审计与阈值校准用 (旧数据 NULL)
    confirms             INTEGER NOT NULL DEFAULT 0,
    supersede_similarity REAL,

    -- 溯源
    chat_id           TEXT NOT NULL,
    memory_id         INTEGER REFERENCES memories (id) ON DELETE SET NULL,
    source_message_ids TEXT NOT NULL DEFAULT '[]',

    -- 权重与统计 (与一阶同口径, 检索打分/衰减复用)
    importance       REAL NOT NULL DEFAULT 0.5
                     CHECK (importance BETWEEN 0 AND 1),
    access_count     INTEGER NOT NULL DEFAULT 0,
    last_accessed_at INTEGER,

    is_active      INTEGER NOT NULL DEFAULT 1,
    created_at     INTEGER NOT NULL,
    updated_at     INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_chunks_entity
    ON attribute_chunks (entity_type, entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_chunks_aspect  ON attribute_chunks (aspect);
CREATE INDEX IF NOT EXISTS idx_chunks_chat    ON attribute_chunks (chat_id);
CREATE INDEX IF NOT EXISTS idx_chunks_valid   ON attribute_chunks (valid_to_event_id);

-- ------------------------------------------------------------
-- V3.1 补充: 物品与组织实体表
-- 六要素之外的常见 RP 实体, 与 people/locations 同构, 供
-- attribute_chunks / memory_entity_refs 的 entity_type 指向
-- ------------------------------------------------------------

-- items: 物品 (信物/武器/道具...)
-- owner_person_id 记录当前持有者 (可空, 易主时改值即可, 流转史走事件)
CREATE TABLE IF NOT EXISTS items (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    name            TEXT NOT NULL,
    aliases         TEXT NOT NULL DEFAULT '[]',
    description     TEXT NOT NULL DEFAULT '',
    owner_person_id INTEGER REFERENCES people (id) ON DELETE SET NULL,
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,
    UNIQUE (name)
);

CREATE INDEX IF NOT EXISTS idx_items_owner ON items (owner_person_id);

-- orgs: 组织 (骑士团/商会/帮派/国家...)
CREATE TABLE IF NOT EXISTS orgs (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    description TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL,
    UNIQUE (name)
);

-- ------------------------------------------------------------
-- V4: stances 相对立场层
-- 关系不是静态名词, 而是可演化的立场状态
--   有向不对称: holder -> target (A对B 与 B对A 是两条记录)
--   一阶: stance_type + intensity(程度)
--   二阶: displayed_type(表里不一) / is_public(公开与否)
--         / target_aware(对方知情与否) / basis(立场依据)
--   时效: 与 attribute_chunks 同口径 (生效区间 + supersedes)
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS stances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,

    -- 立场主体 -> 立场对象 (多态: 人/组织 皆可为主体或对象)
    holder_type   TEXT NOT NULL CHECK (holder_type IN ('person', 'org')),
    holder_id     INTEGER NOT NULL,
    target_type   TEXT NOT NULL CHECK (target_type IN ('person', 'org')),
    target_id     INTEGER NOT NULL,

    -- 一阶: 立场类型 + 程度
    stance_type   TEXT NOT NULL,                 -- 信任/戒备/敌对/友好/爱慕/忠诚/敬畏/轻蔑..., 不锁死
    intensity     REAL NOT NULL DEFAULT 0.5
                  CHECK (intensity BETWEEN 0 AND 1),

    -- 二阶属性
    displayed_type TEXT,                         -- 对外表现的立场; NULL = 表里如一
    is_public     INTEGER NOT NULL DEFAULT 1,    -- 1=公开 0=隐秘
    target_aware  INTEGER NOT NULL DEFAULT 1,    -- 对象是否知晓该立场
    basis         TEXT NOT NULL DEFAULT '',      -- 立场依据 (为何持此立场)

    -- 时效 (防吃书, 与观察块同口径)
    valid_from_event_id  INTEGER REFERENCES events (id) ON DELETE SET NULL,
    valid_to_event_id    INTEGER REFERENCES events (id) ON DELETE SET NULL,
    supersedes_stance_id INTEGER REFERENCES stances (id) ON DELETE SET NULL,

    -- 溯源
    chat_id           TEXT NOT NULL,
    memory_id         INTEGER REFERENCES memories (id) ON DELETE SET NULL,
    source_message_ids TEXT NOT NULL DEFAULT '[]',

    importance      REAL NOT NULL DEFAULT 0.5
                    CHECK (importance BETWEEN 0 AND 1),
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,

    -- ---- V7: 槽位模型 (docs/verb-layer.md §16) ----
    -- 槽位 = (holder, target, stance_dimension); 同槽位的值变化 = 一次迁移 (指针移动)。
    -- 默认 '总体' => 旧数据零漂移; 需要并存的态度面用不同维度声明。
    stance_dimension TEXT NOT NULL DEFAULT '总体',
    -- 值没变、只是再次被观察到的次数 (指针未动, 只累加 —— "不是再造新文本"的落点)
    confirms         INTEGER NOT NULL DEFAULT 0,

    CHECK (NOT (holder_type = target_type AND holder_id = target_id))
);

CREATE INDEX IF NOT EXISTS idx_stances_holder
    ON stances (holder_type, holder_id, is_active);
CREATE INDEX IF NOT EXISTS idx_stances_target
    ON stances (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_stances_valid
    ON stances (valid_to_event_id);
-- V7: 槽位查找路径 (chat, holder, target, dimension)
CREATE INDEX IF NOT EXISTS idx_stances_slot
    ON stances (chat_id, holder_type, holder_id, target_type, target_id, stance_dimension);

-- ============================================================
-- V6: 取值元素层 + 视图隔离 (docs/verb-layer.md §16)
-- ============================================================

-- ------------------------------------------------------------
-- value_nodes: 取值元素层
--
-- 理由: 指针只能指向网中已存在的元素。若取值只是自由字符串, "信任/信赖/信服"
--       就是三个不同文本 —— 指向不同文本 = 没指向同一个元素, 指针语义失效。
--       故取值与实体走同一套 find-or-create + 别名归并。
--
-- kind: 取值域 (stance_type / aspect / ...) —— 同名可在不同域中各建一个节点
-- parent_id: 可选层级 (如 信任 → 态度), 参照 locations.parent_id 的先例
-- ------------------------------------------------------------
CREATE TABLE IF NOT EXISTS value_nodes (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    aliases    TEXT NOT NULL DEFAULT '[]',      -- JSON 数组, 与 people / locations 同口径
    kind       TEXT NOT NULL DEFAULT '',
    parent_id  INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL,
    is_active  INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_value_nodes_name ON value_nodes (name, kind);
CREATE INDEX IF NOT EXISTS idx_value_nodes_parent ON value_nodes (parent_id);

-- ------------------------------------------------------------
-- 视图隔离: 事实层与命题层共用 events 表, 由视图分路
--   事实层代码一律读 v_facts —— 归属命题泄漏进事实层即测试挂
-- ------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_facts AS
    SELECT * FROM events
    WHERE is_active = 1 AND source_type = 'narrator';

CREATE VIEW IF NOT EXISTS v_propositions AS
    SELECT * FROM events
    WHERE is_active = 1 AND source_type <> 'narrator';
