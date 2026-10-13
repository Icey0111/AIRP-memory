// 服务入口: 配置 -> 数据库 -> 迁移 -> HTTP
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createRouter } from './api/routes.js';
import { createCorsMiddleware, describeCors } from './api/cors.js';
import { createLlmClient } from './services/llmClient.js';
import { createEmbeddingClient } from './services/embeddingClient.js';

const config = loadConfig();
const pkg = JSON.parse(fs.readFileSync(path.join(config.serverRoot, 'package.json'), 'utf-8'));

const db = openDatabase(config.db.path);
const version = migrate(db, config.db.schemaDir);
console.log(`[db] 就绪: ${config.db.path} (schema_version=${version})`);

if (config.llm.provider !== 'mock' && !config.llm.apiKey) {
  console.warn('[config] llm.apiKey 未配置, 抽取类功能不可用 (编辑 server/config.json 填入)');
}
if (config.embedding.provider !== 'mock' && !config.embedding.apiKey) {
  console.warn('[config] embedding.apiKey 未配置, 向量检索不可用 (编辑 server/config.json 填入)');
}

const app = express();
// CORS 必须在 express.json 之前: 预检请求 (OPTIONS) 不带 body, 也不该被解析
const corsOptions = config.server.cors ?? { enabled: true, origins: [] };
app.use(createCorsMiddleware(corsOptions));
app.use(express.json({ limit: '2mb' }));
const llm = createLlmClient(config.llm);
const embed = createEmbeddingClient(config.embedding);
app.use(createRouter(db, {
  llm, embed,
  retrieval: config.retrieval,
  runtime: {
    version: pkg.version,
    host: config.server.host,
    port: config.server.port,
    bodyLimit: '2mb',
    cors: describeCors(corsOptions),
  },
}));

const server = app.listen(config.server.port, config.server.host, () => {
  console.log(`[server] 记忆服务已启动: http://${config.server.host}:${config.server.port}`);
});

function shutdown() {
  console.log('\n[server] 正在关闭...');
  server.close(() => {
    db.close();
    process.exit(0);
  });
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
