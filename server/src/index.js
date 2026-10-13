// 服务入口: 配置 -> 数据库 -> 迁移 -> HTTP
import fs from 'node:fs';
import path from 'node:path';
import express from 'express';
import { loadConfig } from './config.js';
import { openDatabase } from './db/connection.js';
import { migrate } from './db/migrate.js';
import { createRouter, jsonErrorHandler } from './api/routes.js';
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

// 绑定地址检查: 本服务无鉴权, 绑定非回环地址等于把整个记忆库暴露给局域网/公网
if (!/^(127\.|localhost$|\[?::1\]?$)/.test(config.server.host)) {
  console.warn(`[server] 警告: 当前绑定 ${config.server.host}, 本服务无鉴权, 请勿绑定非回环地址`);
}

// embedding 模型漂移检测: 换模型/换维度后, 库内旧向量会静默失效
// (维度不符的块不参与向量召回, 也不再建立 supersedes 防吃书链) —— 启动时如实提示
if (config.embedding.provider !== 'mock' && config.embedding.model) {
  try {
    const models = db.prepare(
      'SELECT DISTINCT embedding_model FROM attribute_chunks WHERE embedding IS NOT NULL'
    ).all().map((r) => r.embedding_model).filter(Boolean);
    if (models.length > 0 && !models.includes(config.embedding.model)) {
      console.warn(`[config] 库内观察块向量由 [${models.join(', ')}] 生成, 与当前 embedding.model=${config.embedding.model} 不一致; 旧向量不参与召回与防吃书判定, 建议重建或改回原模型`);
    } else if (models.length > 1) {
      console.warn(`[config] 库内存在多套 embedding 模型 [${models.join(', ')}], 仅与当前模型同维度的块参与召回`);
    }
  } catch { /* 检测失败不影响启动 */ }
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
// 统一 JSON 错误响应 (body 解析失败/超限), 必须在 router 之后挂载
app.use(jsonErrorHandler);

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
