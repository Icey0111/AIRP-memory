// 迁移执行器:
//   空库 -> 执行 db/schema.sql 完整引导 (内含最新 schema_version)
//   旧库 -> 按 schema_version 依次应用 db/migrations/00N_*.sql, 每步校验版本号
import fs from 'node:fs';
import path from 'node:path';

const MIGRATIONS = [
  { version: 2, file: '001_v1_to_v2.sql' },
  { version: 3, file: '002_v2_to_v3.sql' },
  { version: 4, file: '003_v3_to_v4.sql' },
  { version: 5, file: '004_v4_to_v5.sql' },
  { version: 6, file: '005_v5_to_v6.sql' },
  { version: 7, file: '006_v6_to_v7.sql' },
  { version: 8, file: '007_v7_to_v8.sql' },
];
export const LATEST_SCHEMA_VERSION = 8;

export function getSchemaVersion(db) {
  const hasMeta = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='meta'")
    .get();
  if (!hasMeta) return 0;
  const row = db.prepare("SELECT value FROM meta WHERE key='schema_version'").get();
  return row ? Number(row.value) : 0;
}

function execSqlFile(db, filePath) {
  db.exec(fs.readFileSync(filePath, 'utf-8'));
}

export function migrate(db, schemaDir, log = console.log) {
  let version = getSchemaVersion(db);

  if (version === 0) {
    log('[db] 空库, 执行完整 schema 引导');
    execSqlFile(db, path.join(schemaDir, 'schema.sql'));
    version = getSchemaVersion(db);
    log(`[db] 引导完成, schema_version=${version}`);
  } else if (version > LATEST_SCHEMA_VERSION) {
    throw new Error(`数据库 schema_version=${version} 高于本服务支持的 ${LATEST_SCHEMA_VERSION}, 请升级服务`);
  }

  for (const m of MIGRATIONS) {
    if (m.version <= version) continue;
    log(`[db] 迁移 v${m.version - 1} -> v${m.version} (${m.file})`);
    execSqlFile(db, path.join(schemaDir, 'migrations', m.file));
    const now = getSchemaVersion(db);
    if (now !== m.version) {
      throw new Error(`迁移 ${m.file} 后版本异常: 实际 ${now}, 期望 ${m.version}`);
    }
    version = now;
  }

  return version;
}
