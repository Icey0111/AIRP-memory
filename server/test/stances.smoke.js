// V4 立场 + 遗忘衰减冒烟测试: 内存库 + mock LLM, 不触碰真实数据库
// 运行: node test/stances.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { createLlmClient } from '../src/services/llmClient.js';
import { findOrCreatePerson, findOrCreateOrg } from '../src/services/entityService.js';
import {
  addStance, currentStances, findCurrentStance, listStances,
  softDeleteStance, stanceOverview, evolutionOf,
} from '../src/services/stanceService.js';
import { stanceSlots, stanceTransitions } from '../src/services/slotService.js';
import { extractStances } from '../src/services/stanceExtractionService.js';
import { scanForgetCandidates, runForgetTask, restoreForgotten } from '../src/services/forgetService.js';
import { createMemory } from '../src/services/memoryService.js';
import { addChunk } from '../src/services/chunkService.js';
import { now } from '../src/utils/text.js';

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

// ---------- 1) 组织实体 ----------
console.log('\n--- findOrCreateOrg ---');
const org1 = findOrCreateOrg(db, { name: '银手佣兵团', aliases: ['银手'] });
const org2 = findOrCreateOrg(db, { name: '银手' });
check('组织别名归并: 同一名称不重复建行', org2.existed === true && org2.id === org1.id);
check('组织数仍为 1', db.prepare('SELECT COUNT(*) n FROM orgs').get().n === 1);

// ---------- 2) stanceService ----------
console.log('\n--- stanceService ---');
const ella = findOrCreatePerson(db, { name: '艾拉', aliases: ['精灵游侠'] });
const hero = findOrCreatePerson(db, { name: '主角' });

// 自指校验
let selfErr = null;
try {
  addStance(db, {
    holderType: 'person', holderId: ella.id, targetType: 'person', targetId: ella.id,
    stanceType: '信任', chatId: 'chat001',
  });
} catch (e) { selfErr = e; }
check('自指立场被拒绝', selfErr !== null);

const s1 = addStance(db, {
  holderType: 'person', holderId: ella.id, targetType: 'person', targetId: hero.id,
  stanceType: '戒备', intensity: 0.7, basis: '初遇, 不知底细',
  isPublic: true, targetAware: true, chatId: 'chat001', importance: 0.6,
});
check('写入返回 id', s1 === 1);

// V7 槽位规则: 值没变 -> 确认 (不新增行, 只更新幅度 + confirms+1)
const s2 = addStance(db, {
  holderType: 'person', holderId: ella.id, targetType: 'person', targetId: hero.id,
  stanceType: '戒备', intensity: 0.4, basis: '同行后渐生信任, 戒备减轻',
  chatId: 'chat001', importance: 0.7,
});
check('同值再观察 -> 复用同一行 (不新增文本)', s2 === s1, `s1=${s1} s2=${s2}`);
check('确认计数累加且幅度更新',
  db.prepare('SELECT confirms, intensity FROM stances WHERE id = ?').get(s1).confirms === 1
  && db.prepare('SELECT intensity FROM stances WHERE id = ?').get(s1).intensity === 0.4);
const cur = currentStances(db, { holderType: 'person', holderId: ella.id });
check('槽位只有一个当前值', cur.length === 1 && cur[0].id === s1, JSON.stringify(cur.map((s) => s.id)));
check('findCurrentStance 按槽位命中 (不再按类型)',
  findCurrentStance(db, {
    holderType: 'person', holderId: ella.id, targetType: 'person', targetId: hero.id,
    chatId: 'chat001',
  })?.id === s1);

// V7 槽位规则: 值变了 -> 迁移 (指针移动, 写一行短记录并指向前驱)
const s3 = addStance(db, {
  holderType: 'person', holderId: ella.id, targetType: 'person', targetId: hero.id,
  stanceType: '信任', intensity: 0.5, basis: '认可其剑术', chatId: 'chat001',
});
check('值变化 -> 迁移: 新行指向前驱',
  s3 !== s1 && db.prepare('SELECT supersedes_stance_id FROM stances WHERE id = ?').get(s3).supersedes_stance_id === s1,
  `s3=${s3}`);
check('槽位当前值已挪到新值', currentStances(db, {
  holderType: 'person', holderId: ella.id, targetType: 'person', targetId: hero.id, chatId: 'chat001',
})[0].stance_type === '信任');
check('演化链由 supersedes 推导 (戒备 → 信任)', evolutionOf(db, s3) === '戒备 → 信任', String(evolutionOf(db, s3)));

// 并存: 用不同维度声明 (同维度的值变化是迁移, 不是并存)
addStance(db, {
  holderType: 'person', holderId: ella.id, targetType: 'person', targetId: hero.id,
  stanceType: '戒备', intensity: 0.4, basis: '信任其剑术, 但戒备其动机', dimension: '动机',
  chatId: 'chat001',
});
check('不同维度的态度面可并存', currentStances(db, { holderType: 'person', holderId: ella.id }).length === 2);

// 历史口径
const hist = listStances(db, { holderType: 'person', holderId: ella.id, includeHistory: true });
check('历史口径含被迁移掉的旧值 (3 行)', hist.length === 3, String(hist.length));

// 槽位清单: 指针值 + 迁移序列 + 确认次数
const slots = stanceSlots(db, { chatId: 'chat001' });
const totalSlot = slots.find((s) => s.dimension === '总体');
check('槽位清单给出当前指针值与迁移序列',
  totalSlot.value === '信任'
  && totalSlot.transitions.some((t) => t.operation === 'create')
  && totalSlot.transitions.some((t) => t.operation === 'confirm')
  && totalSlot.transitions.some((t) => t.operation === 'migrate' && t.from === '戒备' && t.value === '信任'),
  JSON.stringify(totalSlot.transitions));
check('迁移序列单独可查 (只看值真的变过的)', stanceTransitions(db, { chatId: 'chat001' })
  .some((t) => t.from === '戒备' && t.value === '信任'), JSON.stringify(stanceTransitions(db, { chatId: 'chat001' })));

// overview 带对端名称
const ov = stanceOverview(db, { holderType: 'person', holderId: ella.id });
check('overview 带对端名称', ov.every((s) => s.target_name === '主角'));

// 软删 (撤销: 指针置空, 文本仍在)
check('软删后生效数-1', softDeleteStance(db, s3)
  && currentStances(db, { holderType: 'person', holderId: ella.id }).length === 1);

// ---------- 3) 立场抽取管线 ----------
console.log('\n--- 立场抽取 ---');
db.prepare('DELETE FROM stances').run();
const llmStance = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({
    stances: [
      { holder_type: 'person', holder_name: '艾拉', target_type: 'person', target_name: '主角', stance_type: '信任', intensity: 0.6, displayed_type: null, is_public: true, target_aware: true, basis: '同行数日, 主角替她挡过一箭', importance: 0.7 },
      { holder_type: 'person', holder_name: '艾拉', target_type: 'org', target_name: '银手佣兵团', stance_type: '敌对', intensity: 0.9, displayed_type: '戒备', is_public: false, target_aware: false, basis: '银手悬赏她的族人', importance: 0.8 },
      { holder_type: 'person', holder_name: '主角', target_type: 'person', target_name: '主角', stance_type: '自信', intensity: 0.5 },
    ],
  }),
});
const r1 = await extractStances(db, { llm: llmStance, chatId: 'chat001', text: '(mock 不读)', sourceMessageIds: ['m20'] });
check('抽取落库 2 条', r1.stances.length === 2, JSON.stringify(r1.stances.map((s) => s.stanceType)));
check('自指立场被跳过', r1.skipped === 1);
check('org 对象正确归并', r1.stances[1].target.name === '银手佣兵团');
const dbStance = db.prepare("SELECT * FROM stances WHERE stance_type='敌对'").get();
check('二阶属性落库 (displayed/is_public/target_aware)',
  dbStance.displayed_type === '戒备' && dbStance.is_public === 0 && dbStance.target_aware === 0);

// 演化: 再次抽取同对同类型 -> supersedes
const llmEvolve = createLlmClient({
  provider: 'mock',
  mockResponse: JSON.stringify({
    stances: [
      { holder_type: 'person', holder_name: '精灵游侠', target_type: 'person', target_name: '主角', stance_type: '信任', intensity: 0.85, basis: '生死与共后完全信任', importance: 0.9 },
    ],
  }),
});
const r2 = await extractStances(db, { llm: llmEvolve, chatId: 'chat001', text: '(mock)' });
check('别名 holder 归并到艾拉', r2.stances[0].holder.name === '艾拉');
check('同值再抽取 -> 确认而非新行 (V7 指针语义)',
  r2.stances[0].operation === 'confirm' && r2.stances[0].supersedes === r1.stances[0].id,
  `op=${r2.stances[0].operation} sup=${r2.stances[0].supersedes}`);
check('旧信任立场退出当前生效', currentStances(db, {
  holderType: 'person', holderId: ella.id, targetType: 'person', targetId: hero.id, chatId: 'chat001',
}).filter((s) => s.stance_type === '信任').length === 1);

// ---------- 4) 遗忘衰减任务 ----------
console.log('\n--- 遗忘衰减 ---');
// 造数据: 一条旧低分记忆 / 一条旧高分记忆 / 一条新记忆 / 一条旧低分立场
const mOld = createMemory(db, {
  chatId: 'chat001', scope: 'chat', type: 'fact', content: '旧闻: 王都米价上涨', importance: 0.1,
});
const mImportant = createMemory(db, {
  chatId: 'chat001', scope: 'chat', type: 'fact', content: '核心设定: 主角身世', importance: 0.95,
});
const mNew = createMemory(db, {
  chatId: 'chat001', scope: 'chat', type: 'fact', content: '刚刚发生的事', importance: 0.1,
});
const cOld = addChunk(db, {
  entityType: 'person', entityId: ella.id, aspect: 'detail',
  content: '无关紧要的外观细节', chatId: 'chat001', importance: 0.1,
});
// 回填时间: 100 天前
const old = now() - 100 * 86400;
db.prepare('UPDATE memories SET created_at = ? WHERE id IN (?, ?)').run(old, mOld.id ?? mOld, mImportant.id ?? mImportant);
db.prepare('UPDATE attribute_chunks SET created_at = ? WHERE id = ?').run(old, cOld);
db.prepare('UPDATE stances SET created_at = ? WHERE importance < 0.9').run(old);

// dry-run: 只扫描不改库
const dry = runForgetTask(db, { threshold: 0.25, minAgeDays: 30 });
check('dry-run 不改库', dry.dryRun === true
  && db.prepare('SELECT COUNT(*) n FROM memories WHERE is_active = 0').get().n === 0);
check('旧低分记忆入选候选', dry.candidates.some((c) => c.table === 'memories' && c.id === (mOld.id ?? mOld)));
check('旧低分块入选候选', dry.candidates.some((c) => c.table === 'attribute_chunks' && c.id === cOld));
check('高分记忆被保护', !dry.candidates.some((c) => c.id === (mImportant.id ?? mImportant)));
check('新记忆被保护 (太新)', !dry.candidates.some((c) => c.id === (mNew.id ?? mNew)));
check('候选按分数升序', dry.candidates.every((c, i, a) => i === 0 || a[i - 1].score <= c.score));

// confirm 执行
const exec = runForgetTask(db, { threshold: 0.25, minAgeDays: 30, confirm: true });
check('confirm 执行软遗忘', exec.dryRun === false && exec.forgottenCount === dry.candidateCount);
check('遗忘是软删 (行还在)', db.prepare('SELECT is_active FROM memories WHERE id = ?').get(mOld.id ?? mOld).is_active === 0);
check('高分记忆仍生效', db.prepare('SELECT is_active FROM memories WHERE id = ?').get(mImportant.id ?? mImportant).is_active === 1);

// 二次执行: 已遗忘的不重复处理
const exec2 = runForgetTask(db, { threshold: 0.25, minAgeDays: 30, confirm: true });
check('二次执行无候选', exec2.forgottenCount === 0);

// 恢复
check('恢复遗忘条目', restoreForgotten(db, { table: 'memories', id: mOld.id ?? mOld })
  && db.prepare('SELECT is_active FROM memories WHERE id = ?').get(mOld.id ?? mOld).is_active === 1);
let badTable = null;
try { restoreForgotten(db, { table: 'people', id: 1 }); } catch (e) { badTable = e; }
check('非法表名被拒绝', badTable !== null);

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
