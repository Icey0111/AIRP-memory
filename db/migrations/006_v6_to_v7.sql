-- ============================================================
-- 迁移: V6 -> V7 (槽位模型的存储侧: 立场槽的维度 + 确认计数)
--
-- 设计依据: docs/verb-layer.md §16 (指针语义: 状态迁移不是新文本)
--
-- 本次只加两列, 不新增表, 不复制任何文本:
--   stance_dimension  槽位的"维度" —— 同 (holder, target, dimension) 为一个槽位。
--                     同一槽位上的值变化 = 一次迁移 (指针移动); 需要并存的态度面
--                     (如"信任其能力"与"戒备其动机") 用不同维度声明。
--                     默认 '总体' => 旧数据全部落在同一个槽位上, 零语义漂移。
--   confirms          值没变、只是再次被观察到的次数 (指针未动, 只累加计数)。
--                     这就是"不是再造新文本"的落点: 重复观察不再新增行。
--
-- 迁移记录本身**不建表**: 它从既有的 supersedes 链无损推导
-- (链头 = 当前指针值, 链身 = 迁移序列), 见 src/services/slotService.js。
--
-- 原子性: 包在事务内; 版本号置于事务末尾。
-- ============================================================

PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE stances ADD COLUMN stance_dimension TEXT NOT NULL DEFAULT '总体';
ALTER TABLE stances ADD COLUMN confirms INTEGER NOT NULL DEFAULT 0;

-- 槽位查找路径: (chat, holder, target, dimension)
CREATE INDEX IF NOT EXISTS idx_stances_slot
    ON stances (chat_id, holder_type, holder_id, target_type, target_id, stance_dimension);

UPDATE meta SET value = '7' WHERE key = 'schema_version';

COMMIT;
