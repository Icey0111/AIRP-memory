// V8 属性槽指针语义冒烟测试: 重述判据 / 三种结构操作 / 复现计数口径 / 槽位视图
// 运行: node test/attributes.smoke.js
//
// 这个文件存在的理由 (核心命题, docs/verb-layer.md §16.10):
//   属性观察块原先的 supersedes 链同时被当作两件事 ——
//     ① §4.3 的 ×N 复现计数 ("这条行为被反复看到 N 次")
//     ② §16 的更新链 ("值真的变了")
//   两者本质不同, 混在一起会让人误以为"同一条观察被重复记录了很多次 = 状态迁移了很多次"。
//   V8 把它拆开: **值没变不写新行 (只累加 confirms), 值变了才写一行**。
//
//   判据必须是确定性的: 实测 mock embedding 下"仅标点差异"=0.8385 < 0.85 阈值 ——
//   光靠相似度会把"同一句话换个标点"判成一条**全新的独立观察** (这正是本测试第 ② 组在钉的坑)。
//   于是分工: 规范化文本判等 = 是不是重述; 相似度 = 是不是同一条属性 (建不建链)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createLlmClient } from '../src/services/llmClient.js';
import { createEmbeddingClient, cosine } from '../src/services/embeddingClient.js';
import {
  addChunk, currentChunks, recordObservation, softDeleteChunk,
} from '../src/services/chunkService.js';
import { extractAttributes } from '../src/services/chunkExtractionService.js';
import { findOrCreatePerson } from '../src/services/entityService.js';
import { keyEntities } from '../src/services/graphService.js';
import { entitySketch } from '../src/services/injectionService.js';
import {
  attributeSlots, attributeTransitions, slotSummary,
} from '../src/services/slotService.js';
import { normalizeSlotValue } from '../src/utils/text.js';
import { SLOT_MODEL, THRESHOLDS } from '../src/domain/constants.js';

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

const embed = createEmbeddingClient({ provider: 'mock', mockDim: 128 });
const CHAT = 'chat-v8';
const person = findOrCreatePerson(db, { name: '艾拉' });

// ---------- ① 规范化指纹: 重述判据的底座 ----------
console.log('\n--- ① 规范化指纹 (normalizeSlotValue) ---');
const base = '艾拉嘴上嘲讽遇险却挡在前面';
check('完全一致 => 同指纹', normalizeSlotValue(base) === normalizeSlotValue(base));
check('仅标点差异 => 同指纹 (这是相似度分不开的那一档)',
  normalizeSlotValue('艾拉嘴上嘲讽，遇险却挡在前面。') === normalizeSlotValue(base));
check('仅空白差异 => 同指纹',
  normalizeSlotValue('  艾拉 嘴上 嘲讽 遇险却挡在前面 ') === normalizeSlotValue(base));
check('全角/半角差异 => 同指纹',
  normalizeSlotValue('ＡＢＣ１２３') === normalizeSlotValue('abc123'));
check('英文大小写 => 同指纹',
  normalizeSlotValue('Ela Smirks') === normalizeSlotValue('ela smirks'));
check('插入一个字 => 指纹不同 (措辞变了就是变了)',
  normalizeSlotValue('艾拉嘴上嘲讽但遇险却挡在前面') !== normalizeSlotValue(base));
check('末尾加一句 => 指纹不同',
  normalizeSlotValue(`${base}, 她从不承认`) !== normalizeSlotValue(base));
check('空值安全', normalizeSlotValue(null) === '' && normalizeSlotValue(undefined) === '');

// ---------- ② 三种结构操作: 建立 / 重述 / 迁移 ----------
console.log('\n--- ② recordObservation: 建立 / 重述 / 迁移 ---');
const [vBase, vPunct, vInserted, vOther] = await embed.embed([
  base, '艾拉嘴上嘲讽，遇险却挡在前面。', '艾拉嘴上嘲讽但遇险却挡在前面', '今天晚饭吃火锅',
]);
// 实测记录: 标点差异 0.8385 (低于阈值!) / 插入一个字 0.9095 (高于阈值)
const simPunct = cosine(vBase, vPunct);
const simInserted = cosine(vBase, vInserted);
console.log(`  实测: 标点差异 sim=${simPunct.toFixed(4)} / 插入一字 sim=${simInserted.toFixed(4)} / 阈值=${THRESHOLDS.supersedeSimilarity}`);
check('标点差异相似度**低于**阈值 (所以光靠相似度会误判成新观察)', simPunct < THRESHOLDS.supersedeSimilarity);
check('插入一字相似度**高于**阈值 (会被判成同一条属性的更新)', simInserted >= THRESHOLDS.supersedeSimilarity);

// ① 建立
const r1 = recordObservation(db, {
  entityType: 'person', entityId: person.id, aspect: 'personality', content: base,
  embeddingVec: vBase, embeddingModel: embed.model, chatId: CHAT, sourceMessageIds: ['m1'],
});
check('建立: operation=create, 新行, confirms=0',
  r1.operation === 'create' && r1.confirms === 0 && r1.supersedes === null,
  JSON.stringify(r1));
const rowsAfterCreate = db.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n;

// ② 重述: 逐字相同
const r2 = recordObservation(db, {
  entityType: 'person', entityId: person.id, aspect: 'personality', content: base,
  embeddingVec: vBase, embeddingModel: embed.model, chatId: CHAT, sourceMessageIds: ['m2'],
});
check('重述: operation=confirm, **不新增行**, id 指向原行, confirms=1',
  r2.operation === 'confirm' && r2.id === r1.id && r2.confirms === 1
  && db.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === rowsAfterCreate,
  JSON.stringify(r2));
check('重述不改文本 (原文仍是首次出现的那一份)',
  db.prepare('SELECT content, confirms FROM attribute_chunks WHERE id = ?').get(r1.id).content === base);
check('重述并上新的来源楼层 (溯源不丢)',
  JSON.parse(db.prepare('SELECT source_message_ids s FROM attribute_chunks WHERE id = ?').get(r1.id).s)
    .join(',') === 'm1,m2');

// ③ 重述: 只有标点差异 —— 相似度 0.84 < 0.85, 若按相似度走会被当成新观察
const r3 = recordObservation(db, {
  entityType: 'person', entityId: person.id, aspect: 'personality',
  content: '艾拉嘴上嘲讽，遇险却挡在前面。',
  embeddingVec: vPunct, embeddingModel: embed.model, chatId: CHAT,
});
check('标点差异仍判为**重述**而非新观察 (确定性判据在此救场)',
  r3.operation === 'confirm' && r3.id === r1.id
  && db.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === rowsAfterCreate,
  JSON.stringify(r3));
check('判等用的是指纹, 落库的仍是原文 (指纹只做判等, 不上屏)',
  db.prepare('SELECT content FROM attribute_chunks WHERE id = ?').get(r1.id).content === base);

// ④ 迁移: 措辞真的变了 (相似度够高 => 同一条属性的新值)
const r4 = recordObservation(db, {
  entityType: 'person', entityId: person.id, aspect: 'personality',
  content: '艾拉嘴上嘲讽但遇险却挡在前面',
  embeddingVec: vInserted, embeddingModel: embed.model, chatId: CHAT,
});
check('迁移: operation=update, 写新行, 指向前驱',
  r4.operation === 'update' && r4.id !== r1.id && r4.supersedes === r1.id, JSON.stringify(r4));
check('迁移留档相似度 (审计与将来校准用)',
  Math.abs(db.prepare('SELECT supersede_similarity s FROM attribute_chunks WHERE id = ?').get(r4.id).s
    - simInserted) < 1e-4,
  String(db.prepare('SELECT supersede_similarity s FROM attribute_chunks WHERE id = ?').get(r4.id).s));
check('迁移不删旧行 (可回溯, 原文一字不删)',
  db.prepare('SELECT COUNT(*) n FROM attribute_chunks WHERE id = ?').get(r1.id).n === 1);
check('旧值退出当前生效, 只剩新值',
  currentChunks(db, { entityType: 'person', entityId: person.id }).map((c) => c.content).join('|')
    === '艾拉嘴上嘲讽但遇险却挡在前面');

// ⑤ 无关内容 => 独立观察 (低相似度不建链)
const r5 = recordObservation(db, {
  entityType: 'person', entityId: person.id, aspect: 'personality',
  content: '今天晚饭吃火锅', embeddingVec: vOther, embeddingModel: embed.model, chatId: CHAT,
});
check('无关内容: operation=create 且不建链 (低相似度 = 另一条观察)',
  r5.operation === 'create' && r5.supersedes === null, JSON.stringify(r5));
check('同一槽位可并存多条观察链 (属性本就多元, 不是遗留数据)',
  currentChunks(db, { entityType: 'person', entityId: person.id, aspect: 'personality' }).length === 2);

// ⑥ 无向量时也要能重述判等 (纯文本路径)
const r6 = recordObservation(db, {
  entityType: 'person', entityId: person.id, aspect: 'personality',
  content: '今天晚饭吃火锅', chatId: CHAT,
});
check('无 embedding 时重述判等仍成立 (不需要向量的路径)',
  r6.operation === 'confirm' && r6.id === r5.id && r6.confirms === 1, JSON.stringify(r6));

// ---------- ③ 复现计数口径: ×N = 总观察次数 (旧数据零漂移) ----------
console.log('\n--- ③ 复现计数 ×N 的口径 ---');
db.prepare('DELETE FROM attribute_chunks').run();
const p2 = findOrCreatePerson(db, { name: '苏' });
// 旧式链: 3 行 supersedes, confirms 全 0 (V8 之前的数据长这样)
const legacy1 = addChunk(db, {
  entityType: 'person', entityId: p2.id, aspect: 'habit', content: '照例先倒杯酒', chatId: CHAT,
});
const legacy2 = addChunk(db, {
  entityType: 'person', entityId: p2.id, aspect: 'habit', content: '照例先倒杯酒, 从不问价',
  supersedesChunkId: legacy1, chatId: CHAT,
});
const legacy3 = addChunk(db, {
  entityType: 'person', entityId: p2.id, aspect: 'habit', content: '照例先倒杯酒, 从不问价, 还会多要一碟',
  supersedesChunkId: legacy2, chatId: CHAT,
});
const legacyEnt = keyEntities(db, { chatId: CHAT }).find((e) => e.name === '苏');
check('旧数据零漂移: 3 行链 (confirms=0) => ×3, 与 V8 之前完全一致',
  legacyEnt.depth === 3 && legacyEnt.confirms === 0, JSON.stringify({ d: legacyEnt.depth, c: legacyEnt.confirms }));

// 新式: 当前值被逐字重复观察 4 次 => 只累加 confirms, 行数不涨
for (let i = 1; i <= 4; i++) {
  recordObservation(db, {
    entityType: 'person', entityId: p2.id, aspect: 'habit',
    content: '照例先倒杯酒, 从不问价, 还会多要一碟',
    embeddingVec: (await embed.embed(['x']))[0], embeddingModel: embed.model, chatId: CHAT,
  });
}
const ent2 = keyEntities(db, { chatId: CHAT }).find((e) => e.name === '苏');
check('重复观察 4 次只累加 confirms, 行数不变 (3 行)',
  db.prepare('SELECT COUNT(*) n FROM attribute_chunks WHERE entity_id = ?').get(p2.id).n === 3);
check('×N 把 confirms 折进去: 3 行链 + 4 次确认 = 7 次观察',
  ent2.depth === 7 && ent2.confirms === 4, JSON.stringify({ d: ent2.depth, c: ent2.confirms }));
check('速写里的 ×N 就是总观察次数 (面板与模型同口径)',
  entitySketch(ent2).includes('×7'), entitySketch(ent2));
check('上报 confirms 字段供面板区分"同值重述"与"值迁移"', ent2.confirms === 4);

// ---------- ④ 属性槽视图: 迁移记录从链推导 ----------
console.log('\n--- ④ 属性槽 (attributeSlots) ---');
db.prepare('DELETE FROM attribute_chunks').run();
const p3 = findOrCreatePerson(db, { name: '雷' });
const T_A = '雷习惯在窗边守夜从不合眼';
const T_A2 = '雷习惯在窗边守夜, 从不合眼';        // 仅标点差异 => 重述 (指纹相同)
const T_B = '雷习惯在窗边守着夜从不合眼';          // 措辞变了 + 相似度 0.90 => 迁移
const T_C = '雷习惯在窗边守着夜从不合上眼';        // 再迁移一跳
const [va1, va2, vab, vac] = await embed.embed([T_A, T_A2, T_B, T_C]);
recordObservation(db, {
  entityType: 'person', entityId: p3.id, aspect: 'habit', content: T_A,
  embeddingVec: va1, embeddingModel: embed.model, chatId: CHAT,
});
recordObservation(db, {
  entityType: 'person', entityId: p3.id, aspect: 'habit', content: T_A,
  embeddingVec: va1, embeddingModel: embed.model, chatId: CHAT,
});
// 这一条相似度够高 (>= 阈值), 但指纹相同 —— 判定顺序保证它走"确认"而不是"迁移"
const punctInChain = recordObservation(db, {
  entityType: 'person', entityId: p3.id, aspect: 'habit', content: T_A2,
  embeddingVec: va2, embeddingModel: embed.model, chatId: CHAT,
});
check('判定顺序: 先判重述再判相似度 (够相似但指纹相同 => 确认, 不迁成一次伪迁移)',
  punctInChain.operation === 'confirm' && cosine(va1, va2) >= THRESHOLDS.supersedeSimilarity,
  `${punctInChain.operation} sim=${cosine(va1, va2).toFixed(4)}`);
recordObservation(db, {
  entityType: 'person', entityId: p3.id, aspect: 'habit', content: T_B,
  embeddingVec: vab, embeddingModel: embed.model, chatId: CHAT,
});
recordObservation(db, {
  entityType: 'person', entityId: p3.id, aspect: 'habit', content: T_C,
  embeddingVec: vac, embeddingModel: embed.model, chatId: CHAT,
});

const slots = attributeSlots(db, { chatId: CHAT });
const slot = slots.find((s) => s.entityName === '雷');
check('属性槽位键 = (实体, 维度)', slot?.key === `person:${p3.id}@habit`, slot?.key);
check('槽位当前值 = 链头 = 最新值', slot?.value === T_C, slot?.value);
check('槽位总观察次数 = 5 (3 行 + 2 次重述)', slot?.observations === 5, String(slot?.observations));
check('链头 confirms=0 (最后一行还没被重复观察到)', slot?.confirms === 0);
const chain = slot?.chains?.[0];
check('一条链 (相似度足够 => 串成同一条属性的历史)', slot?.chains?.length === 1,
  String(slot?.chains?.length));
check('链上只有 3 行 (重述不写行: 5 次观察 3 行)',
  chain.transitions.filter((t) => t.operation !== 'confirm').length === 3,
  JSON.stringify(chain.transitions.map((t) => t.operation)));
check('链上有 create / confirm(带计数) / migrate 三种操作',
  ['create', 'confirm', 'migrate'].every((op) => chain.transitions.some((t) => t.operation === op)),
  JSON.stringify(chain.transitions.map((t) => t.operation)));
check('迁移记下 from (旧原文) 与 value (新原文) —— 展示永远用原文不用指纹',
  chain.transitions.some((t) => t.operation === 'migrate' && t.from === T_A && t.value === T_B)
  && chain.transitions.some((t) => t.operation === 'migrate' && t.from === T_B && t.value === T_C),
  JSON.stringify(chain.transitions));
check('确认条目带次数 (这一行被逐字重复看到 2 次)',
  chain.transitions.some((t) => t.operation === 'confirm' && t.count === 2),
  JSON.stringify(chain.transitions));
check('迁移留档相似度 (仅措辞变过的行有值)',
  Math.abs(chain.supersedeSimilarity - cosine(vac, vab)) < 1e-4,
  String(chain.supersedeSimilarity));

const moves = attributeTransitions(db, { chatId: CHAT });
check('迁移序列只收"值真的变过"的那些', moves.length === 2 && moves.every((m) => m.operation === 'migrate'),
  String(moves.length));
check('迁移序列带槽位坐标 (entityName + aspect)',
  moves[0].entityName === '雷' && moves[0].aspect === 'habit');

// ---------- ⑤ 汇总: 与立场槽并列 ----------
console.log('\n--- ⑤ slotSummary ---');
const summary = slotSummary(db, { chatId: CHAT });
check('属性槽与立场槽并列下发 (两个 kind)', summary.slotDefs.map((d) => d.kind).join(',') === 'stance,attribute');
check('属性槽清单已上报', Array.isArray(summary.attributeSlots) && summary.attributeSlots.length >= 1);
check('属性操作计数已上报', summary.attributeCounts.create >= 1 && summary.attributeCounts.confirm >= 1
  && summary.attributeCounts.migrate >= 1, JSON.stringify(summary.attributeCounts));
check('立场槽的计数单独一份 (两类槽位不混算)',
  Object.keys(summary.counts).join(',') === Object.keys(summary.attributeCounts).join(','));
check('操作标签取自 constants (跨端同源)',
  Object.keys(summary.labels).length === SLOT_MODEL.operations.length
  && summary.labels.migrate === SLOT_MODEL.operations.find((o) => o.value === 'migrate').label);
check('重述判据随汇总下发 (面板要能解释"为什么同一句话只算一次")',
  summary.restatement?.rule === 'normalize-equal' && summary.restatement?.rule === SLOT_MODEL.restatement.rule);
check('属性槽定义已从"待 V8"更新为已实现',
  !/待 V8/.test(SLOT_MODEL.slotDefs.find((d) => d.kind === 'attribute').note));

// ---------- ⑤' 撤销: 指针置空, 前驱不复活 ----------
console.log('\n--- ⑤\' 撤销链头 ---');
softDeleteChunk(db, chain.chunkId);
check('撤销链头后该槽位不再有当前值 (不做自动回退)',
  attributeSlots(db, { chatId: CHAT }).every((s) => s.chains.every((c) => c.chunkId !== chain.chunkId)));
check('撤销不删文本 (行仍在, 可恢复)',
  db.prepare('SELECT COUNT(*) n FROM attribute_chunks WHERE id = ?').get(chain.chunkId).n === 1);

// ---------- ⑥ 抽取管线端到端: operation 透出 ----------
console.log('\n--- ⑥ 抽取管线 ---');
db.prepare('DELETE FROM attribute_chunks').run();
const obs = JSON.stringify({
  observations: [
    { entity_type: 'person', entity_name: '艾拉', aspect: 'habit', content: '每次进门都先嘲讽一句', importance: 0.7 },
  ],
});
const mkLlm = () => createLlmClient({ provider: 'mock', mockResponse: obs });
const first = await extractAttributes(db, { llm: mkLlm(), embed, chatId: CHAT, text: 'x' });
check('首次抽取 => operation=create', first.chunks[0]?.operation === 'create', JSON.stringify(first.chunks[0]));
const second = await extractAttributes(db, { llm: mkLlm(), embed, chatId: CHAT, text: 'y' });
check('再次抽到同一句 => operation=confirm 且不新增行',
  second.chunks[0]?.operation === 'confirm'
  && db.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === 1,
  JSON.stringify(second.chunks[0]));
check('返回体带 confirms 供上层展示', second.chunks[0]?.confirms === 1);

db.close();
console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
