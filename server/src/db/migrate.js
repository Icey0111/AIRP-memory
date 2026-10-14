// 迁移执行器:
//   空库 -> 执行 db/schema.sql 完整引导 (内含最新 schema_version)
//   旧库 -> 按 schema_version 依次应用 db/migrations/00N_*.sql, 每步校验版本号
//
// V10 起多一步**词表灌入**: 词表内容 (规范词/别名/上位类) 是语义, 只在 domain/constants.js
//   定义一次 —— 因此不放 SQL 里 (抄一份 SQL 就是第二语义源, 迟早漂移), 而是每次启动
//   幂等灌一遍 (种子词表随服务升级一起演进)。旧数据的机械归一只在跨 v10 那一次跑。
import fs from 'node:fs';
import path from 'node:path';
import { seedVocabulary, backfillVocabulary } from '../services/vocabularyService.js';

const MIGRATIONS = [
  { version: 2, file: '001_v1_to_v2.sql' },
  { version: 3, file: '002_v2_to_v3.sql' },
  { version: 4, file: '003_v3_to_v4.sql' },
  { version: 5, file: '004_v4_to_v5.sql' },
  { version: 6, file: '005_v5_to_v6.sql' },
  { version: 7, file: '006_v6_to_v7.sql' },
  { version: 8, file: '007_v7_to_v8.sql' },
  { version: 9, file: '008_v8_to_v9.sql' },
  { version: 10, file: '009_v9_to_v10.sql' },
];
export const LATEST_SCHEMA_VERSION = 10;

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
  const before = getSchemaVersion(db);
  let version = before;

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

  // 词表: 先灌种子 (词表外的旧词才有规范词可归), 再机械归一旧数据
  const seeded = seedVocabulary(db);
  if (seeded.created || seeded.updated) {
    log(`[db] 词表种子: 新建 ${seeded.created} 个元素, 补别名/上位类 ${seeded.updated} 个`);
  }
  if (before < 10) {
    const bf = backfillVocabulary(db);
    const filled = Object.entries(bf.filled).map(([k, v]) => `${k}:${v}`).join(' ');
    log(`[db] 词表回填 (V10): ${filled}; 新建待审 ${bf.created.length} 个`
      + (bf.merged.length ? `; 并入旧别名元素 ${bf.merged.length} 个 (${bf.merged.slice(0, 4).join(', ')})` : '')
      + (bf.splitTimeLabels ? `; 拆开整句时间标签 ${bf.splitTimeLabels} 个` : ''));
  }

  return version;
}
