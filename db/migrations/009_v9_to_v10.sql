-- ============================================================
-- 迁移: V9 -> V10 (词表即节点: 七个语义域落成取值元素, 实例改存指针)
--
-- 背景问题 (2026-10-15 对真实库实测, 属**语义无法复用**而非冗余):
--   谓词 / 题元角色 / 情态 / 从句角色 / 对齐状态一直是**裸 TEXT 列**。
--   "拦截盘查"与"盘查"是两个不同文本 —— 于是"同一个谓词被 N 个实例复用"这件事
--   在库里根本不存在: 40 条实例 33 个谓词, 复用度 1.21, 仅 20% 命中词表;
--   角色中英各一套 (agent×19 与 发起者×8 并存), 仅 25% 落在词表内。
--
--   **后果不止是图难看**: 命题对齐的硬条件是"同动词"(VERB_LAYER.alignment) ——
--   谓词不成词表 => 从句与事实永远不同动词 => 真假判定一次都没生效
--   (实测: 10 条归属命题, 判定成功 0 条, 全部停在 pending)。
--
-- 修法: 沿用 V7 既有原则 (**元素先于指针**, value_nodes) —— 七个域全部落成取值元素,
--   实例只存 id。旧文本列保留为"归一后的词"(缓存), 写入路径同时写两处, 由
--   test/vocabulary.smoke.js 钉住不漂移, 因此注入 / 检索 / 冻结尾区零改动。
--
-- ⚠️ 本文件**只做 DDL**。词表内容 (规范词 / 别名 / 谓词上位类) 是语义, 只在
--   domain/constants.js 定义一次, 由 vocabularyService.seedVocabulary() 在迁移后灌入;
--   旧数据的机械归一 (agent→发起者, appearance→外貌, 拦截盘查挂上位类…) 走
--   backfillVocabulary() —— 它只填空指针 (NULL), 可重复执行。
--   把 267 条别名抄进 SQL 等于制造第二份语义源, 迟早漂移。
--
-- 原子性: 包在事务内; 版本号置于事务末尾。
-- ============================================================

PRAGMA foreign_keys = ON;

BEGIN;

-- ① 取值元素的自描述列 (待审队列的载体)
ALTER TABLE value_nodes ADD COLUMN gloss  TEXT NOT NULL DEFAULT '';
ALTER TABLE value_nodes ADD COLUMN source TEXT NOT NULL DEFAULT 'seed';
ALTER TABLE value_nodes ADD COLUMN status TEXT NOT NULL DEFAULT 'ok';
ALTER TABLE value_nodes ADD COLUMN note   TEXT NOT NULL DEFAULT '';

-- 旧库里已有的 value_nodes 都是抽取时随手建的 (aspect / stance_type), 先如实标成 extracted;
-- seedVocabulary 随后会把命中规范词的那批改回 seed + ok
UPDATE value_nodes SET source = 'extracted';

-- ② 实例 -> 取值元素 的指针
ALTER TABLE events ADD COLUMN predicate_id INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN attitude_id  INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN clause_id    INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;
ALTER TABLE events ADD COLUMN status_id    INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;
ALTER TABLE event_participants ADD COLUMN role_id INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;
ALTER TABLE attribute_chunks   ADD COLUMN aspect_id INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;
ALTER TABLE stances            ADD COLUMN stance_type_id INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;
-- 时间点的**时段指针** (指针-only 域: label 是世界内时刻的名字, 不是归一后的词, 所以没有文本缓存)
ALTER TABLE time_points        ADD COLUMN period_id INTEGER REFERENCES value_nodes (id) ON DELETE SET NULL;

-- ③ 指针的查询路径 ("这个谓词被哪些实例用"是复用度统计的热路径)
CREATE INDEX IF NOT EXISTS idx_events_predicate ON events (predicate_id);
CREATE INDEX IF NOT EXISTS idx_events_attitude  ON events (attitude_id);
CREATE INDEX IF NOT EXISTS idx_events_clause    ON events (clause_id);
CREATE INDEX IF NOT EXISTS idx_events_status_id ON events (status_id);
CREATE INDEX IF NOT EXISTS idx_event_participants_role ON event_participants (role_id);
CREATE INDEX IF NOT EXISTS idx_chunks_aspect_id ON attribute_chunks (aspect_id);
CREATE INDEX IF NOT EXISTS idx_stances_type_id  ON stances (stance_type_id);
CREATE INDEX IF NOT EXISTS idx_time_points_period ON time_points (period_id);

-- ④ 待审队列的查询路径
CREATE INDEX IF NOT EXISTS idx_value_nodes_status ON value_nodes (kind, status, is_active);

UPDATE meta SET value = '10' WHERE key = 'schema_version';

COMMIT;
