-- ============================================================
-- 迁移: V2 -> V3 (新增三阶语义层: 属性观察块 + 画像溯源列)
-- 用法: 对已有的 V2 数据库执行本文件; 全新部署直接用 db/schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

UPDATE meta SET value = '3' WHERE key = 'schema_version';

-- 画像条目增加溯源列: 记录由哪些观察块归纳而来
ALTER TABLE character_profiles
    ADD COLUMN derived_from_chunk_ids TEXT NOT NULL DEFAULT '[]';

CREATE TABLE IF NOT EXISTS attribute_chunks (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,

    entity_type    TEXT NOT NULL
                   CHECK (entity_type IN ('person', 'location')),
    entity_id      INTEGER NOT NULL,

    aspect         TEXT NOT NULL,

    content        TEXT NOT NULL,
    embedding      BLOB,

    valid_from_event_id INTEGER REFERENCES events (id) ON DELETE SET NULL,
    valid_to_event_id   INTEGER REFERENCES events (id) ON DELETE SET NULL,
    supersedes_chunk_id INTEGER REFERENCES attribute_chunks (id) ON DELETE SET NULL,

    chat_id           TEXT NOT NULL,
    memory_id         INTEGER REFERENCES memories (id) ON DELETE SET NULL,
    source_message_ids TEXT NOT NULL DEFAULT '[]',

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
