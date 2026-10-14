-- ============================================================
-- 迁移: V8 -> V9 (事件的来源窗口锚定 + 重述计数)
--
-- 背景问题 (2026-10-14 真实模型实测踩到, 属**数据丢失**而非冗余):
--   events 的幂等判据长期是"同 chat 同 title", 而 title 曾被写成实例 label
--   (`title = label || verbSurface || verbType`)。合并抽取每个窗口都从 e1 开始编号,
--   于是第二段剧情里同样叫 e1 的实例被判为"已存在" → 整条事件被静默丢弃。
--   实测: 窗口 1 (艾拉出门) 落 2 条, 窗口 2 (铁匠放剑) 落 **0 条**。
--
-- 为什么错: label("e1")是**模型在一次输出内的临时编号**, 不是跨窗口的身份。
--   身份必须带来源窗口 —— 同 chat + 同来源楼层集合 + 同 label/title 才算重述。
--   这与属性层的确定性判据(规范化文本判等)、立场层的槽位指针是同一思路:
--   判等键必须是确定性的, 不能用模型每次都可能变的措辞。
--
-- 本次加两列 + 一个索引, **不新增表**:
--   label      模型给的实例标签, 与描述性 title 分开存
--              (历史数据按旧口径回填 label = title, 旧库零漂移)
--   confirms   同窗口重述次数。重述**不新增行**, 只计数 —— 与属性层/立场层对称。
--              这样"同一窗口被重复抽取"是无害的(可重跑), 而不同窗口绝不互相吞并。
--
-- 原子性: 包在事务内; 版本号置于事务末尾。
-- ============================================================

PRAGMA foreign_keys = ON;

BEGIN;

ALTER TABLE events ADD COLUMN label TEXT;
ALTER TABLE events ADD COLUMN confirms INTEGER NOT NULL DEFAULT 0;

-- 旧库: 老的 title 就是 label (当时口径), 回填后跨窗口判等行为不变
UPDATE events SET label = title WHERE label IS NULL;

-- 判等键的索引: (chat_id, label) 用于同窗口重述查找
CREATE INDEX IF NOT EXISTS idx_events_chat_label ON events (chat_id, label);

UPDATE meta SET value = '9' WHERE key = 'schema_version';

COMMIT;
