-- ============================================================
-- 迁移: V7 -> V8 (属性槽的指针语义: 重述计数 + 相似度留档)
--
-- 设计依据: docs/verb-layer.md §16.10 (属性槽的迁移判定)
--
-- 背景问题: 观察块的 supersedes 链原先同时被当作两件事 ——
--   ① §4.3 的 ×N 复现计数 ("这条行为被反复观察到 N 次")
--   ② §16 的更新链 (值真的变了)
--   两者本质不同: 重复观察不该产生新值, 值变了才是迁移。
--
-- 本次加两列, 不新增表:
--   confirms            规范化后文本相同的重复观察次数。
--                       重复观察**不再新增行** (与立场层的 confirms 对称) —— 这就是
--                       "状态迁移不是新文本"在属性层的落点。
--   supersede_similarity 该行与其前驱的余弦相似度 (审计与将来的阈值校准用; 旧数据 NULL)。
--
-- 重述判据为何不用相似度阈值: 实测 mock embedding 下"仅标点差异"=0.85、
--   "末尾加一句"=0.81, 与"真正的更新"落在同一区间 —— 阈值会卡在噪声里。
--   改用**确定性判据**: 规范化(去空白/统一标点)后文本完全相同 => 重述;
--   只要措辞变了 => 更新 (措辞变化可能带新细节, 宁可多存一行也不丢细节)。
--
-- 原子性: 包在事务内; 版本号置于事务末尾。
-- ============================================================

PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE attribute_chunks ADD COLUMN confirms INTEGER NOT NULL DEFAULT 0;
ALTER TABLE attribute_chunks ADD COLUMN supersede_similarity REAL;

UPDATE meta SET value = '8' WHERE key = 'schema_version';

COMMIT;
