-- ============================================================
-- 迁移: V5 -> V6 (动词层与命题层 + 取值元素层)
--
-- 设计依据: docs/verb-layer.md
-- 用法: 对已有的 V5 数据库执行本文件; 全新部署直接用 db/schema.sql
--
-- 本迁移做了四件事:
--   1) events 加 11 列: 动词槽 + 命题三轴(时态/来源/状态) + 极性 + 嵌套 + 对齐指针
--   2) 重建 event_links: relation 的 CHECK 扩入 conditional / alternative
--      (SQLite 无法修改 CHECK, 只能重建表 —— 这是本迁移唯一的破坏性操作)
--   3) 新增 value_nodes: 取值元素层 (V7-A 提前建表, 结构变更一次做完)
--   4) 新增视图 v_facts / v_propositions: 事实层与命题层的读路径隔离
--
-- 向后兼容: source_type 默认 'narrator' —— 全部旧数据自动成为"叙述者断言的事实",
--           零语义漂移, 无需回填。
-- 原子性: 整体包在事务内 (本迁移含破坏性 DDL, 失败必须整体回滚, 不留半成品)。
-- 注意: PRAGMA foreign_keys 在事务内是 no-op, 故本文件不依赖它;
--       没有任何表引用 event_links, 直接 DROP 是安全的。
-- ============================================================

PRAGMA foreign_keys = ON;

BEGIN;

-- ------------------------------------------------------------
-- 1) events: 动词槽与命题三轴
-- ------------------------------------------------------------

-- 动词槽: 归一用 verb_type (受控词表建议值), 原文永不丢用 verb_surface
ALTER TABLE events ADD COLUMN verb_type   TEXT NOT NULL DEFAULT '';
ALTER TABLE events ADD COLUMN verb_surface TEXT NOT NULL DEFAULT '';

-- 极性: 参与对齐判定 (命题 ¬P 匹配到事实 P => 判「被推翻」, 不是「兑现」)
ALTER TABLE events ADD COLUMN polarity    TEXT NOT NULL DEFAULT '+'
                  CHECK (polarity IN ('+', '-'));

-- 轴② 担保来源: 叙述者断言 (进事实层) 或 归属给某人 (进命题层)
ALTER TABLE events ADD COLUMN source_type TEXT NOT NULL DEFAULT 'narrator'
                  CHECK (source_type IN ('narrator', 'attributed'));
ALTER TABLE events ADD COLUMN source_person_id INTEGER
                  REFERENCES people (id) ON DELETE SET NULL;
-- 情态: 说 / 认为 / 相信 / 希望 / 怀疑 / 假装 / 不知 (仅 attributed)
ALTER TABLE events ADD COLUMN attitude    TEXT;

-- 轴① 时态定位: 只决定"到没到点", 与来源正交
ALTER TABLE events ADD COLUMN tense       TEXT NOT NULL DEFAULT 'past'
                  CHECK (tense IN ('past', 'now', 'future'));

-- 轴③ 对齐状态: asserted | pending | realized | failed | inactive | refuted | voided
ALTER TABLE events ADD COLUMN status      TEXT NOT NULL DEFAULT 'asserted';

-- 对齐指针: 命题兑现/证实后指向对应的事实实例 (指针语义, 不新增文本行)
ALTER TABLE events ADD COLUMN aligned_instance_id INTEGER
                  REFERENCES events (id) ON DELETE SET NULL;

-- 嵌套引述: 命题宾语(comp) / 条件前件(cond) / 择一候选(alt), 深度上限 2 (应用层约束)
ALTER TABLE events ADD COLUMN parent_instance_id  INTEGER
                  REFERENCES events (id) ON DELETE CASCADE;
ALTER TABLE events ADD COLUMN parent_role TEXT;

CREATE INDEX IF NOT EXISTS idx_events_verb    ON events (verb_type);
CREATE INDEX IF NOT EXISTS idx_events_status  ON events (status, chat_id);
CREATE INDEX IF NOT EXISTS idx_events_source  ON events (source_type);
CREATE INDEX IF NOT EXISTS idx_events_parent  ON events (parent_instance_id);
CREATE INDEX IF NOT EXISTS idx_events_aligned ON events (aligned_instance_id);

-- ------------------------------------------------------------
-- 2) 重建 event_links: relation 词表扩入条件边与择一边
-- ------------------------------------------------------------
CREATE TABLE event_links_new (
    from_id    INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    relation   TEXT NOT NULL
               CHECK (relation IN ('caused', 'led_to', 'preceded', 'contradicts',
                                   'conditional', 'alternative')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, relation),
    CHECK (from_id <> to_id)
);

INSERT INTO event_links_new (from_id, to_id, relation, created_at)
    SELECT from_id, to_id, relation, created_at FROM event_links;

DROP TABLE event_links;
ALTER TABLE event_links_new RENAME TO event_links;

-- ------------------------------------------------------------
-- 3) value_nodes: 取值元素层
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
-- 4) 视图隔离: 事实层与命题层走同一个表, 由视图分路
--    (事实层代码一律读 v_facts, 归属命题泄漏即测试挂)
-- ------------------------------------------------------------
CREATE VIEW IF NOT EXISTS v_facts AS
    SELECT * FROM events
    WHERE is_active = 1 AND source_type = 'narrator';

CREATE VIEW IF NOT EXISTS v_propositions AS
    SELECT * FROM events
    WHERE is_active = 1 AND source_type <> 'narrator';

-- ------------------------------------------------------------
-- 版本号: 置于事务末尾 —— 中途失败则版本停留 5, migrate() 会随即抛出
-- ------------------------------------------------------------
UPDATE meta SET value = '6' WHERE key = 'schema_version';

COMMIT;
