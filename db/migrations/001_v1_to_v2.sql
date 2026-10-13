-- ============================================================
-- 迁移: V1 -> V2 (新增语义实体层)
-- 用法: 对已有的 V1 数据库执行本文件; 全新部署直接用 db/schema.sql
-- ============================================================

PRAGMA foreign_keys = ON;

UPDATE meta SET value = '2' WHERE key = 'schema_version';

CREATE TABLE IF NOT EXISTS people (
    id           INTEGER PRIMARY KEY AUTOINCREMENT,
    name         TEXT NOT NULL,
    aliases      TEXT NOT NULL DEFAULT '[]',
    person_type  TEXT NOT NULL DEFAULT 'npc'
                 CHECK (person_type IN ('main', 'npc', 'mentioned')),
    description  TEXT NOT NULL DEFAULT '',
    is_active    INTEGER NOT NULL DEFAULT 1,
    created_at   INTEGER NOT NULL,
    updated_at   INTEGER NOT NULL,
    UNIQUE (name)
);

CREATE TABLE IF NOT EXISTS locations (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    aliases     TEXT NOT NULL DEFAULT '[]',
    parent_id   INTEGER REFERENCES locations (id) ON DELETE SET NULL,
    description TEXT NOT NULL DEFAULT '',
    is_active   INTEGER NOT NULL DEFAULT 1,
    created_at  INTEGER NOT NULL,
    updated_at  INTEGER NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_locations_parent ON locations (parent_id);

CREATE TABLE IF NOT EXISTS time_points (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    chat_id    TEXT NOT NULL,
    label      TEXT NOT NULL,
    seq        INTEGER NOT NULL DEFAULT 0,
    parent_id  INTEGER REFERENCES time_points (id) ON DELETE SET NULL,
    note       TEXT NOT NULL DEFAULT '',
    created_at INTEGER NOT NULL,
    UNIQUE (chat_id, label)
);

CREATE INDEX IF NOT EXISTS idx_time_points_chat_seq
    ON time_points (chat_id, seq);

CREATE TABLE IF NOT EXISTS events (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    title             TEXT NOT NULL,
    process           TEXT NOT NULL DEFAULT '',
    cause_text        TEXT NOT NULL DEFAULT '',
    result_text       TEXT NOT NULL DEFAULT '',
    time_id           INTEGER REFERENCES time_points (id) ON DELETE SET NULL,
    location_id       INTEGER REFERENCES locations (id) ON DELETE SET NULL,
    chat_id           TEXT NOT NULL,
    memory_id         INTEGER REFERENCES memories (id) ON DELETE SET NULL,
    source_message_ids TEXT NOT NULL DEFAULT '[]',
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

CREATE TABLE IF NOT EXISTS event_participants (
    event_id  INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    person_id INTEGER NOT NULL REFERENCES people (id) ON DELETE CASCADE,
    role      TEXT NOT NULL DEFAULT '参与者',
    PRIMARY KEY (event_id, person_id, role)
);

CREATE INDEX IF NOT EXISTS idx_event_participants_person
    ON event_participants (person_id);

CREATE TABLE IF NOT EXISTS event_links (
    from_id    INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    to_id      INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
    relation   TEXT NOT NULL
               CHECK (relation IN ('caused', 'led_to', 'preceded', 'contradicts')),
    created_at INTEGER NOT NULL,
    PRIMARY KEY (from_id, to_id, relation),
    CHECK (from_id <> to_id)
);

CREATE TABLE IF NOT EXISTS memory_entity_refs (
    memory_id   INTEGER NOT NULL REFERENCES memories (id) ON DELETE CASCADE,
    entity_type TEXT NOT NULL
                CHECK (entity_type IN ('person', 'location', 'event')),
    entity_id   INTEGER NOT NULL,
    PRIMARY KEY (memory_id, entity_type, entity_id)
);

CREATE INDEX IF NOT EXISTS idx_memory_entity_refs_entity
    ON memory_entity_refs (entity_type, entity_id);
