-- ============================================================
-- 迁移: V4 -> V5 (新增相对立场层 stances)
-- 用法: 对已有的 V4 数据库执行本文件; 全新部署直接用 db/schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

UPDATE meta SET value = '5' WHERE key = 'schema_version';

CREATE TABLE IF NOT EXISTS stances (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,

    holder_type   TEXT NOT NULL CHECK (holder_type IN ('person', 'org')),
    holder_id     INTEGER NOT NULL,
    target_type   TEXT NOT NULL CHECK (target_type IN ('person', 'org')),
    target_id     INTEGER NOT NULL,

    stance_type   TEXT NOT NULL,
    intensity     REAL NOT NULL DEFAULT 0.5
                  CHECK (intensity BETWEEN 0 AND 1),

    displayed_type TEXT,
    is_public     INTEGER NOT NULL DEFAULT 1,
    target_aware  INTEGER NOT NULL DEFAULT 1,
    basis         TEXT NOT NULL DEFAULT '',

    valid_from_event_id  INTEGER REFERENCES events (id) ON DELETE SET NULL,
    valid_to_event_id    INTEGER REFERENCES events (id) ON DELETE SET NULL,
    supersedes_stance_id INTEGER REFERENCES stances (id) ON DELETE SET NULL,

    chat_id           TEXT NOT NULL,
    memory_id         INTEGER REFERENCES memories (id) ON DELETE SET NULL,
    source_message_ids TEXT NOT NULL DEFAULT '[]',

    importance      REAL NOT NULL DEFAULT 0.5
                    CHECK (importance BETWEEN 0 AND 1),
    is_active       INTEGER NOT NULL DEFAULT 1,
    created_at      INTEGER NOT NULL,
    updated_at      INTEGER NOT NULL,

    CHECK (NOT (holder_type = target_type AND holder_id = target_id))
);

CREATE INDEX IF NOT EXISTS idx_stances_holder
    ON stances (holder_type, holder_id, is_active);
CREATE INDEX IF NOT EXISTS idx_stances_target
    ON stances (target_type, target_id);
CREATE INDEX IF NOT EXISTS idx_stances_valid
    ON stances (valid_to_event_id);
