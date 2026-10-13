// 生效画像层: 无条件常驻 prompt 的角色键值画像
import { now } from '../utils/text.js';

export function getProfile(db, characterId) {
  return db.prepare(`
    SELECT * FROM character_profiles
    WHERE character_id = ?
    ORDER BY category, key
  `).all(characterId);
}

// upsert: (character_id, category, key) 唯一, 覆盖式更新
export function upsertProfileEntry(db, { characterId, category, key, value, derivedFromChunkIds = [] }) {
  if (!characterId || !category || !key) throw new Error('characterId/category/key 必填');
  db.prepare(`
    INSERT INTO character_profiles (character_id, category, key, value, derived_from_chunk_ids, updated_at)
    VALUES (@characterId, @category, @key, @value, @chunks, @ts)
    ON CONFLICT (character_id, category, key)
    DO UPDATE SET value = @value, derived_from_chunk_ids = @chunks, updated_at = @ts
  `).run({
    characterId, category, key,
    value: String(value ?? ''),
    chunks: JSON.stringify(derivedFromChunkIds),
    ts: now(),
  });
  return db.prepare(
    'SELECT * FROM character_profiles WHERE character_id = ? AND category = ? AND key = ?'
  ).get(characterId, category, key);
}

export function deleteProfileEntry(db, characterId, category, key) {
  const info = db.prepare(
    'DELETE FROM character_profiles WHERE character_id = ? AND category = ? AND key = ?'
  ).run(characterId, category, key);
  return info.changes > 0;
}
