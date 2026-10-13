// 配置加载: config.default.json 为底, config.json (用户自填, gitignored) 深合并覆盖
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const serverRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function isPlainObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function deepMerge(base, override) {
  const out = { ...base };
  for (const [k, v] of Object.entries(override)) {
    out[k] = isPlainObject(v) && isPlainObject(base[k]) ? deepMerge(base[k], v) : v;
  }
  return out;
}

export function loadConfig() {
  const defaults = loadConfigDefaults();
  const userPath = path.join(serverRoot, 'config.json');
  const user = fs.existsSync(userPath)
    ? JSON.parse(fs.readFileSync(userPath, 'utf-8'))
    : {};
  const config = deepMerge(defaults, user);

  // 路径统一解析为绝对路径 (相对路径以 server/ 为基准)
  config.serverRoot = serverRoot;
  config.projectRoot = path.resolve(serverRoot, '..');
  config.db.path = path.resolve(serverRoot, config.db.path);
  config.db.schemaDir = path.resolve(serverRoot, config.db.schemaDir);

  return config;
}

/** config.default.json 原文 (configService 的合并底; 相对路径保持未解析形态) */
export function loadConfigDefaults() {
  return JSON.parse(
    fs.readFileSync(path.join(serverRoot, 'config.default.json'), 'utf-8')
  );
}
