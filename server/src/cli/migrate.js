// CLI: 仅执行数据库迁移, 不启动服务
// 用法: npm run migrate
import { loadConfig } from '../config.js';
import { openDatabase } from '../db/connection.js';
import { migrate, getSchemaVersion } from '../db/migrate.js';

const config = loadConfig();
const db = openDatabase(config.db.path);

try {
  const version = migrate(db, config.db.schemaDir);
  console.log(`[migrate] 完成, 当前 schema_version=${version}`);
} catch (err) {
  console.error(`[migrate] 失败: ${err.message}`);
  process.exitCode = 1;
} finally {
  db.close();
}
