-- ============================================================
-- 迁移: V3 -> V4 (schema 冻结前补丁)
-- 内容:
--   1) memories / attribute_chunks 增加 embedding_model 列
--   2) attribute_chunks / memory_entity_refs 的 entity_type CHECK
--      放开 'item' / 'org' (SQLite 不能改 CHECK, 需重建表)
--   3) 新增 items / orgs 实体表
-- 用法: 对已有的 V3 数据库执行本文件; 全新部署直接用 db/schema.sql
-- ============================================================

PRAGMA foreign_keys = OFF;
BEGIN;

UPDATE meta SET value = '4' WHERE key = 'schema_version';

-- 1) memories 加列 (简单 ALTER)
ALTER TABLE memories ADD COLUMN embedding_model TEXT;

-- 2a) 重建 attribute_chunks: 新 CHECK + 新列
CREATE TABLE attribute_chunks_new (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    entity_type    TEXT NOT NULL
                   CHECK (entity_type IN ('person', 'location', 'item', 'org')),
    entity_id      INTEGER NOT NULL,
    aspect         TEXT NOT NULL,
    content        TEXT NOT NULL,
    embedding      BLOB,
    embedding_model TEXT,
    valid_from_event_id INTEGER REFERENCES events (id) ON DELETE SET NULL,
    valid_to_event_id   INTEGER REFERENCES events (id) ON DELETE SET NULL,
    supersedes_chunk_id INTEGER REFERENCES attribute_chunks_new (id) ON DELETE SET NULL,
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

INSERT INTO attribute_chunks_new (
    id, entity_type, entity_id, aspect, content, embedding,
    valid_from_event_id, valid_to_event_id, supersedes_chunk_id,
    chat_id, memory_id, source_message_ids,
    importance, access_count, last_accessed_at,
    is_active, created_at, updated_at
)
SELECT
    id, entity_type, entity_id, aspect, content, embedding,
    valid_from_event_id, valid_to_event_id, supersedes_chunk_id,
    chat_id, memory_id, source_message_ids,
    importance, access_count, last_accessed_at,
    is_active, created_at, updated_at
FROM attribute_chunks;

DROP TABLE attribute_chunks;
ALTER TABLE attribute_chunks_new RENAME TO attribute_chunks;

CREATE INDEX IF NOT EXISTS idx_chunks_entity
    ON attribute_chunks (entity_type, entity_id, is_active);
CREATE INDEX IF NOT EXISTS idx_chunks_aspect  ON attribute_chunks (aspect);
CREATE INDEX IF NOT EXISTS idx_chunks_chat    ON attribute_chunks (chat_id);
CREATE INDEX IF NOT EXISTS idx_chunks_valid   ON attribute_chunks (valid_to_event_id);

-- 2b) 重建 memory_entity_refs: 新 CHECK
CREATE TABLE memory_entity_refs_new (
    memory_id   INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL
                CHECK (entity_type IN ('person', 'location', 'event', 'item', 'org')),
    entity_id   INTEGER NOT NULL,
    PRIMARY KEY (memory_id, entity_type, entity_id)
);

INSERT INTO memory_entity_refs_new (memory_id, entity_type, entity_id)
SELECT memory_id, entity_type, entity_id FROM memory_entity_refs;

DROP TABLE memory_entity_refs;
ALTER TABLE memory_entity_refs_new RENAME TO memory_entity_refs;

CREATE INDEX IF NOT EXISTS idx_memory_entity_refs_entity
    ON memory_entity_refs (entity_type, entity_id);

-- 3) 新实体表
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

COMMIT;
PRAGMA foreign_keys = ON;
