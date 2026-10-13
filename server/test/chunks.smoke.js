// 三阶属性观察块冒烟测试: 内存库 + mock LLM + mock embedding, 不触碰真实数据库
// 运行: node test/chunks.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createLlmClient } from '../src/services/llmClient.js';
import {
  createEmbeddingClient, packVector, unpackVector, cosine,
} from '../src/services/embeddingClient.js';
import {
  addChunk, currentChunks, listChunks, softDeleteChunk, searchChunksByVector,
} from '../src/services/chunkService.js';
import { extractAttributes, deriveProfile } from '../src/services/chunkExtractionService.js';
import { findOrCreatePerson } from '../src/services/entityService.js';
import { getProfile } from '../src/services/profileService.js';
import { searchChunks, assembleContext } from '../src/services/retrievalService.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const db = new Database(':memory:');
db.pragma('foreign_keys = ON');
migrate(db, path.join(projectRoot, 'db'), () => {});
console.log(`schema_version = ${getSchemaVersion(db)}`);

// ---------- 1) BLOB 序列化与余弦 ----------
console.log('\n--- BLOB 序列化 ---');
const v0 = [0.1, -0.2, 0.3, 1e-7];
const round = unpackVector(packVector(v0));
check('pack/unpack 往返一致', round.every((x, i) => Math.abs(x - v0[i]) < 1e-7));
check('cosine 自相似=1', Math.abs(cosine(v0, v0) - 1) < 1e-6);
check('cosine 正交=0', Math.abs(cosine([1, 0], [0, 1])) < 1e-9);
check('unpack null 安全', unpackVector(null) === null);

// ---------- 2) mock embedding ----------
console.log('\n--- mock embedding ---');
const embed = createEmbeddingClient({ provider: 'mock', mockDim: 128 });
const [va, vb, vc] = await embed.embed(['艾拉性格冷静', '艾拉性格很冷静', '今天晚饭吃火锅']);
check('mock 确定性: 同文本同向量', JSON.stringify(await embed.embed(['艾拉性格冷静']))
  === JSON.stringify([va]));
check('相似文本余弦 > 无关文本', cosine(va, vb) > cosine(va, vc),
  `sim(a,b)=${cosine(va, vb).toFixed(3)} sim(a,c)=${cosine(va, vc).toFixed(3)}`);
check('向量已归一化', Math.abs(va.reduce((s, x) => s + x * x, 0) - 1) < 1e-6);

// ---------- 3) 观察块写入 / 生效口径 / 覆盖链 ----------
console.log('\n--- chunkService ---');
const [e1] = await embed.embed(['艾拉惯用左手剑']);
const id1 = addChunk(db, {
  entityType: 'person', entityId: 1, aspect: 'habit',
  content: '艾拉惯用左手剑', embeddingVec: e1, embeddingModel: embed.model,
  chatId: 'chat001', importance: 0.7,
});
const id2 = addChunk(db, {
  entityType: 'person', entityId: 1, aspect: 'habit',
  content: '艾拉改练双手剑', supersedesChunkId: id1,
  chatId: 'chat001', importance: 0.8,
});
check('写入返回自增 id', id1 === 1 && id2 === 2);
const cur = currentChunks(db, { entityType: 'person', entityId: 1 });
check('被覆盖块退出当前生效', cur.length === 1 && cur[0].id === id2, JSON.stringify(cur.map((c) => c.id)));
const hist = listChunks(db, { entityType: 'person', entityId: 1, includeHistory: true });
check('历史口径含全部块', hist.length === 2);
check('向量 BLOB 已落库', hist[0].embedding instanceof Buffer && hist[0].embedding.length === 128 * 4);
check('软删后当前生效为空', softDeleteChunk(db, id2) && currentChunks(db, { entityType: 'person', entityId: 1 }).length === 0);
check('重复软删返回 false', softDeleteChunk(db, id2) === false);

// ---------- 4) 暴力余弦召回 ----------
console.log('\n--- 向量召回 ---');
db.prepare('DELETE FROM attribute_chunks').run();
const texts = ['艾拉惯用左手剑', '夜莺酒馆炉火很旺', '主角害怕打雷'];
const vecs = await embed.embed(texts);
for (let i = 0; i < texts.length; i++) {
  addChunk(db, {
    entityType: i === 1 ? 'location' : 'person', entityId: i + 1,
    aspect: 'detail', content: texts[i], embeddingVec: vecs[i],
    embeddingModel: embed.model, chatId: 'chat001',
  });
}
const [qv] = await embed.embed(['艾拉的剑术习惯']);
const ranked = searchChunksByVector(db, { queryVec: qv, chatId: 'chat001', topK: 3 });
check('召回 3 条且按相似度降序', ranked.length === 3
  && ranked[0].similarity >= ranked[1].similarity
  && ranked[1].similarity >= ranked[2].similarity);
check('最相关的是剑术块', ranked[0].content === '艾拉惯用左手剑',
  `实际 top1: ${ranked[0].content} (${ranked[0].similarity.toFixed(3)})`);
const chatScoped = searchChunksByVector(db, { queryVec: qv, chatId: 'other-chat', topK: 3 });
check('chat 隔离: 其他 chat 召回为空', chatScoped.length === 0);

// ---------- 5) 三阶抽取管线 (mock LLM + mock embed) ----------
console.log('\n--- 属性观察抽取 ---');
db.prepare('DELETE FROM attribute_chunks').run();
// 预置: 艾拉带别名"精灵游侠" (别名注册是二阶实体层的事, 三阶只管归并)
findOrCreatePerson(db, { name: '艾拉', aliases: ['精灵游侠'] });
const llmExtract = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({
    observations: [
      { entity_type: 'person', entity_name: '艾拉', aspect: 'personality', content: '艾拉性格冷静, 遇事先观察再行动', importance: 0.8 },
      { entity_type: 'person', entity_name: '精灵游侠', aspect: 'appearance', content: '艾拉有一双翠绿色的眼睛', importance: 0.6 },
      { entity_type: 'location', entity_name: '夜莺酒馆', aspect: 'atmosphere', content: '夜莺酒馆总是弥漫着烤肉香', importance: 0.5 },
      { entity_type: 'item', entity_name: '左手剑', aspect: 'detail', content: '(item 应被跳过)' },
    ],
  }),
});
const r1 = await extractAttributes(db, {
  llm: llmExtract, embed,
  chatId: 'chat001', text: '(mock 不读)', sourceMessageIds: ['m10'],
});
check('抽取落库 3 块', r1.chunks.length === 3, JSON.stringify(r1.chunks.map((c) => c.aspect)));
check('item 观察被跳过并计数', r1.skipped === 1);
check('别名归并: 精灵游侠 -> 艾拉 (同实体)', r1.chunks[0].entityName === '艾拉' && r1.chunks[1].entityName === '艾拉');
check('块带 embedding_model', db.prepare('SELECT embedding_model m FROM attribute_chunks').all()
  .every((r) => r.m === 'mock-bigram'));

// supersedes 判定: 同实体同维度的高相似观察应覆盖旧块
const llmUpdate = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({
    observations: [
      { entity_type: 'person', entity_name: '艾拉', aspect: 'personality', content: '艾拉性格冷静, 遇事先观察局势再行动', importance: 0.9 },
    ],
  }),
});
const r2 = await extractAttributes(db, { llm: llmUpdate, embed, chatId: 'chat001', text: '(mock)' });
check('高相似观察建立 supersedes 覆盖链', r2.chunks[0].supersedes === r1.chunks[0].id,
  `supersedes=${r2.chunks[0].supersedes} sim=${r2.chunks[0].similarity}`);
const ellaIdForCheck = db.prepare("SELECT id FROM people WHERE name='艾拉'").get().id;
const ellaPersonality = currentChunks(db, { aspect: 'personality', chatId: 'chat001' })
  .filter((c) => c.entity_id === ellaIdForCheck);
check('旧 personality 块退出当前生效', ellaPersonality.length === 1
  && ellaPersonality[0].content.includes('局势'), JSON.stringify(ellaPersonality.map((c) => c.content)));

// ---------- 6) 画像重归纳 ----------
console.log('\n--- 画像重归纳 ---');
const llmDerive = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({
    entries: [
      { category: 'personality', key: '行事风格', value: '冷静谨慎, 先观察再行动' },
      { category: 'appearance', key: '眼睛', value: '翠绿色' },
    ],
  }),
});
const ellaId = db.prepare("SELECT id FROM people WHERE name='艾拉'").get().id;
const r3 = await deriveProfile(db, { llm: llmDerive, personId: ellaId, characterId: '艾拉' });
check('归纳出 2 条画像', r3.entries.length === 2);
const profile = getProfile(db, '艾拉');
check('画像已写入 character_profiles', profile.length === 2, JSON.stringify(profile.map((p) => p.key)));
const pStyle = profile.find((p) => p.key === '行事风格');
check('画像带块溯源', pStyle && JSON.parse(pStyle.derived_from_chunk_ids).length >= 1);

// ---------- 7) 检索层第三路 + 注入组装 ----------
console.log('\n--- 检索第三路 / 注入 ---');
const { hits: vecHits } = await searchChunks(db, embed, { query: '艾拉的性格', chatId: 'chat001', topK: 4 });
check('searchChunks 有命中且带 score', vecHits.length > 0 && vecHits.every((h) => typeof h.score === 'number'));
const ctx = await assembleContext(db, embed, {
  query: '艾拉的性格', chatId: 'chat001', characterId: '艾拉', topK: 4, tokenBudget: 1200,
});
check('注入含画像段', ctx.text.includes('【角色画像】'));
check('注入含细节段', ctx.text.includes('【相关细节】'), ctx.text.slice(0, 120));
check('画像计数正确', ctx.profileCount === 2);
check('细节命中计数正确', ctx.chunkHitCount === ctx.chunkHitIds.length && ctx.chunkHitCount > 0);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
