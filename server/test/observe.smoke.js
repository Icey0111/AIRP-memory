// 组合抽取 (/api/observe) 冒烟测试: 内存库 + 可控 fake LLM / fake embedding
//
// 这个文件钉的是**不变式与形状**, 不是抽取质量:
//   1) 默认 merged 模式: 整轮只发**一次** LLM 调用 (输入只送一遍);
//   2) 三层落库齐全, 且观察/立场借同一份输出的实例 label **挂到触发它的事件上**
//      (valid_from_event_id —— 分开抽时这一步物理上做不到, 锚点永远为空);
//   3) merged 整份解析失败 → 降级为分步并行, 不丢数据, 并如实标注 mode;
//   4) 分步路径 (补跑 / 降级) 的性质: 三步并行、共享同一文本与同一组来源楼层、单步失败不中断;
//   5) 合并输出带 label ⇒ 同文本重跑幂等 (事件按标题复用, 观察只累加计数);
//   6) 合并 prompt 与三个单步 prompt 的**共有关键条款**没漂移。
// 运行: node test/observe.smoke.js
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { observeText } from '../src/services/observeService.js';
import { OBSERVE_PIPELINE, OBSERVE_STEP_IDS, LLM_LIMITS } from '../src/domain/constants.js';
import { MERGED_PROMPT } from '../src/services/mergedExtraction.js';
import { SYSTEM_PROMPT } from '../src/services/extractionService.js';
import { VERB_LAYER, VOCABULARY_WORDS } from '../src/domain/constants.js';
import { EXTRACT_SYSTEM as OBS_PROMPT } from '../src/services/chunkExtractionService.js';
import { EXTRACT_SYSTEM as STANCE_PROMPT } from '../src/services/stanceExtractionService.js';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

const CHAT = 'chat-observe';
const TEXT = '艾拉把匕首放回桌上。她说：明天去镇上找铁匠。';
const FLOORS = ['101', '102'];

// ---------- 可控 fake LLM ----------
const CALLS = [];

/** 三层的固定输出 (单步用) */
function cannedReply(which) {
  if (which === 'instances') {
    return JSON.stringify({
      people: [{ name: '艾拉', person_type: 'npc' }],
      locations: [{ name: '房间' }],
      time_point: { label: '第二天早上' },
      instances: [{
        label: 'e1', verb_type: '放置', title: '艾拉把匕首放回桌上',
        tense: 'past', polarity: 'affirmative', source_type: 'narrator',
        participants: [{ name: '艾拉', role: 'agent' }],
      }],
    });
  }
  if (which === 'attributes') {
    return JSON.stringify({
      observations: [{ entity_type: 'person', entity_name: '艾拉', aspect: 'habit', content: '随身带匕首', importance: 0.6 }],
    });
  }
  if (which === 'stances') {
    return JSON.stringify({
      stances: [{
        holder_type: 'person', holder_name: '艾拉', target_type: 'person', target_name: '铁匠',
        stance_type: '戒备', intensity: 0.6, basis: '上次被骗过',
      }],
    });
  }
  if (which === 'merged') {
    // 合并输出: 四个分区一次给全; 观察与立场用 event 引用同一份输出里的实例 label
    return JSON.stringify({
      people: [{ name: '艾拉', person_type: 'npc' }],
      locations: [{ name: '房间' }],
      time_point: { label: '第二天早上' },
      instances: [{
        label: 'e1', verb_type: '放置', title: '艾拉把匕首放回桌上',
        tense: 'past', polarity: 'affirmative', source_type: 'narrator',
        participants: [{ name: '艾拉', role: 'agent' }],
      }],
      observations: [{
        entity_type: 'person', entity_name: '艾拉', aspect: 'habit',
        content: '随身带匕首', importance: 0.6, event: 'e1',
      }],
      stances: [{
        holder_type: 'person', holder_name: '艾拉', target_type: 'person', target_name: '铁匠',
        stance_type: '戒备', intensity: 0.6, basis: '上次被骗过', event: 'e1',
      }],
    });
  }
  throw new Error('fake LLM 收到未知 system');
}

function whichOf(system) {
  if (/一次性记忆抽取器/.test(system)) return 'merged';
  return /述谓抽取器/.test(system) ? 'instances'
    : /属性观察抽取器/.test(system) ? 'attributes'
      : /立场抽取器/.test(system) ? 'stances'
        : 'unknown';
}

function makeLlm({ failOn = null, garbage = false, record = true, reply = null } = {}) {
  return {
    describe: () => ({ provider: 'fake', configured: true, model: 'fake', reason: null }),
    async chat({ system, user, maxTokens }) {
      const which = whichOf(system);
      if (record) CALLS.push({ which, system, user, maxTokens });
      if (failOn === which) throw new Error(`fake LLM 在 ${which} 步故障`);
      if (garbage && which === 'merged') return '这不是 JSON, 也没有大括号';
      return reply ? reply(which) : cannedReply(which);
    },
  };
}

function makeEmbed() {
  return {
    model: 'fake-embed',
    describe: () => ({ provider: 'fake', configured: true, model: 'fake-embed', reason: null }),
    async embed(texts) {
      return texts.map((t) => {
        const v = new Array(8).fill(0);
        for (let i = 0; i < t.length; i++) v[i % 8] += (t.charCodeAt(i) % 17) / 17;
        const n = Math.hypot(...v) || 1;
        return v.map((x) => x / n);
      });
    },
  };
}

const freshDb = () => {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  migrate(db, path.join(projectRoot, 'db'), () => {});
  return db;
};

console.log(`schema_version = ${getSchemaVersion(freshDb())}`);

// ---------- 1) 管线常量 + prompt 条款漂移守卫 ----------
console.log('\n--- 管线与 prompt 条款 ---');
check('管线三步 id 与常量导出一致',
  OBSERVE_STEP_IDS.join(',') === 'instances,attributes,stances', OBSERVE_STEP_IDS.join(','));
check('只有属性观察步依赖 embedding',
  OBSERVE_PIPELINE.filter((s) => s.needsEmbedding).map((s) => s.id).join(',') === 'attributes');

// 合并 prompt 必须与单步 prompt 保持同样的硬条款 —— 只改一处会被这里抓到
const sharedClauses = [
  { clause: '照原样重复', why: '属性层靠"一字不差"判重述' },
  { clause: '反复出现', why: '琐事归观察不建事件' },
  { clause: 'attributed', why: '归属内容不得写成事实' },
  { clause: '必须有人物名', why: '身份锚定段的存在前提' },
];
check('合并 prompt 含三层共用硬条款',
  ['source_type', 'attributed', '照原样重复', '反复出现的日常行为', '有向', 'event']
    .every((k) => MERGED_PROMPT.includes(k)),
  ['source_type', 'attributed', '照原样重复', '反复出现的日常行为', '有向', 'event']
    .filter((k) => !MERGED_PROMPT.includes(k)).join(', '));
// V10: 逻辑关系三种结构 + 封闭词表 —— 曾经只有单步 prompt 有 alternatives/conditional,
// 而 dsh 活跃路径走合并 prompt => 条件与择一在真实数据里恒为 0 条, 且测试抓不到
check('两处 prompt 都声明了三种逻辑结构 (comp / conditional / alternatives)',
  ['comp', 'conditional', 'alternatives'].every((k) => MERGED_PROMPT.includes(k) && SYSTEM_PROMPT.includes(k)),
  ['comp', 'conditional', 'alternatives']
    .filter((k) => !(MERGED_PROMPT.includes(k) && SYSTEM_PROMPT.includes(k))).join(', '));
check('两处 prompt 都写了「要么…要么…」与「是否」的落法',
  ['要么', '是否'].every((k) => MERGED_PROMPT.includes(k) && SYSTEM_PROMPT.includes(k)));
check('两处 prompt 的封闭词表与 constants 同源 (动词/情态/题元角色)',
  VOCABULARY_WORDS.predicate.every((w) => MERGED_PROMPT.includes(w) && SYSTEM_PROMPT.includes(w))
  && VERB_LAYER.attitudes.every((a) => MERGED_PROMPT.includes(a.value) && SYSTEM_PROMPT.includes(a.value))
  && VERB_LAYER.thematicRoles.every((r) => MERGED_PROMPT.includes(r.value) && SYSTEM_PROMPT.includes(r.value)),
  `合并缺: ${VOCABULARY_WORDS.predicate.filter((w) => !MERGED_PROMPT.includes(w)).join(',')}`
  + ` | 单步缺: ${VOCABULARY_WORDS.predicate.filter((w) => !SYSTEM_PROMPT.includes(w)).join(',')}`);
check('两处 prompt 都禁止短语型谓词 (把对象塞进动词)',
  MERGED_PROMPT.includes('拦截盘查') && SYSTEM_PROMPT.includes('拦截盘查'));
check('单步 prompt 的条款仍在 (漂移守卫的前提)',
  SYSTEM_PROMPT.includes('attributed') && OBS_PROMPT.includes('照原样重复')
  && STANCE_PROMPT.includes('有向') && sharedClauses.length === 4);
check('合并 prompt 声明了 event 锚点键 (跨层关联的唯一入口)',
  MERGED_PROMPT.includes('"event"') && MERGED_PROMPT.includes('不要编造'));

// ---------- 2) merged 默认: 整轮只一次 LLM 调用 ----------
console.log('\n--- merged 默认: 一次调用出三层 ---');
CALLS.length = 0;
const db = freshDb();
const merged = await observeText(db, { llm: makeLlm(), embed: makeEmbed() }, {
  chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS,
  characterName: '艾拉', userName: '林',
});

check('**整轮只发一次 LLM 调用**', CALLS.length === 1 && merged.llmCalls === 1,
  JSON.stringify({ calls: CALLS.length, llmCalls: merged.llmCalls }));
check('发的是合并 prompt 而非三个单步 prompt', CALLS[0].which === 'merged', CALLS[0].which);
// 输出预算必须按抽取档给: 走会话档 (config 里 2048) 时真实模型会在 observations 中途被截断,
// stances 整段消失 —— 而假 LLM 不会截断, 所以只能靠这条传参断言看守。
check('合并调用显式传入抽取档输出上限 (防真实截断)',
  CALLS[0].maxTokens === LLM_LIMITS.extractionMaxTokens,
  JSON.stringify({ got: CALLS[0].maxTokens, want: LLM_LIMITS.extractionMaxTokens }));
check('没有分区缺失时 missingZones 为空',
  Array.isArray(merged.missingZones) && merged.missingZones.length === 0,
  JSON.stringify(merged.missingZones));
check('mode=merged, partial=false, 三层都报 ok',
  merged.mode === 'merged' && merged.partial === false
  && ['instances', 'attributes', 'stances'].every((k) => merged.steps[k]?.ok === true),
  JSON.stringify({ mode: merged.mode, partial: merged.partial }));
check('三层都落了库',
  db.prepare('SELECT COUNT(*) n FROM events').get().n === 1
  && db.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === 1
  && db.prepare('SELECT COUNT(*) n FROM stances').get().n === 1,
  JSON.stringify({
    events: db.prepare('SELECT COUNT(*) n FROM events').get().n,
    chunks: db.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n,
    stances: db.prepare('SELECT COUNT(*) n FROM stances').get().n,
  }));
check('事件来源楼层与观察/立场同源 (同一组 sourceMessageIds)',
  db.prepare('SELECT source_message_ids s FROM attribute_chunks').get().s === JSON.stringify(FLOORS)
  && db.prepare('SELECT source_message_ids s FROM stances').get().s === JSON.stringify(FLOORS));

// ===== 合并抽取的独家收益: 跨层锚点被填上 =====
const evId = db.prepare('SELECT id FROM events').get().id;
const obsAnchor = db.prepare('SELECT valid_from_event_id v FROM attribute_chunks').get().v;
const stanceAnchor = db.prepare('SELECT valid_from_event_id v FROM stances').get().v;
check('观察挂到了触发它的事件上 (valid_from_event_id)',
  obsAnchor === evId, JSON.stringify({ obsAnchor, evId }));
check('立场挂到了触发它的事件上 (valid_from_event_id)',
  stanceAnchor === evId, JSON.stringify({ stanceAnchor, evId }));
check('响应里如实上报锚点命中数',
  merged.anchored.observations === 1 && merged.anchored.stances === 1,
  JSON.stringify(merged.anchored));
check('响应里给出分区规模 (便于判断这段剧情有没有该层内容)',
  merged.zones.instances === 1 && merged.zones.observations === 1 && merged.zones.stances === 1,
  JSON.stringify(merged.zones));

// ===== 同文本重跑幂等 (合并输出带 label ⇒ 事件按标题复用) =====
CALLS.length = 0;
const again = await observeText(db, { llm: makeLlm(), embed: makeEmbed() }, {
  chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS,
});
check('同文本重跑仍是 1 次调用', CALLS.length === 1 && again.llmCalls === 1, String(CALLS.length));
check('重跑不新增事件 (按 label/title 复用), 观察只累加计数',
  db.prepare('SELECT COUNT(*) n FROM events').get().n === 1
  && db.prepare('SELECT confirms c FROM attribute_chunks').get().c >= 1,
  JSON.stringify({
    events: db.prepare('SELECT COUNT(*) n FROM events').get().n,
    confirms: db.prepare('SELECT confirms c FROM attribute_chunks').get().c,
  }));

// ---------- 3) 输出缺分区 → 如实上报 (不猜原因) ----------
console.log('\n--- 输出缺分区: 如实上报 missingZones ---');
{
  CALLS.length = 0;
  const dbMiss = freshDb();
  // 模拟"输出被截断": stances 整段没出现
  const miss = await observeText(dbMiss, {
    llm: makeLlm({ reply: (w) => (w === 'merged' ? JSON.stringify({
      people: [{ name: '艾拉', person_type: 'npc' }],
      instances: [{ label: 'e1', verb_type: '放置', title: '艾拉把匕首放回桌上', source_type: 'narrator' }],
      observations: [{ entity_type: 'person', entity_name: '艾拉', aspect: 'habit', content: '随身带匕首', event: 'e1' }],
      // stances 缺失
    }) : cannedReply(w)) }),
    embed: makeEmbed(),
  }, { chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS });
  check('缺的分区被如实点名 (调用方据此用 steps 补跑那一层)',
    miss.missingZones.join(',') === 'stances', JSON.stringify(miss.missingZones));
  check('缺分区不影响已产出分区的落库',
    dbMiss.prepare('SELECT COUNT(*) n FROM events').get().n === 1
    && dbMiss.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === 1,
    JSON.stringify({
      events: dbMiss.prepare('SELECT COUNT(*) n FROM events').get().n,
      chunks: dbMiss.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n,
    }));
  check('缺分区仍只发一次调用 (不自动补跑 —— 补跑是调用方的选择)',
    CALLS.length === 1, String(CALLS.length));
}

// ---------- 4) merged 解析失败 → 降级分步并行 ----------
console.log('\n--- merged 失败 → 降级分步 ---');
CALLS.length = 0;
const dbFb = freshDb();
const fb = await observeText(dbFb, { llm: makeLlm({ garbage: true }), embed: makeEmbed() }, {
  chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS,
});
check('mode=split-fallback 且如实给出 mergedError',
  fb.mode === 'split-fallback' && typeof fb.mergedError === 'string' && fb.mergedError.length > 0,
  JSON.stringify({ mode: fb.mode, err: fb.mergedError }));
check('降级后仍把三层写进库 (不丢数据)',
  dbFb.prepare('SELECT COUNT(*) n FROM events').get().n === 1
  && dbFb.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === 1
  && dbFb.prepare('SELECT COUNT(*) n FROM stances').get().n === 1);
check('降级路径发的是三个单步 prompt (1 次合并 + 3 次分步 = 4)',
  CALLS.filter((c) => c.which === 'merged').length === 1 && CALLS.filter((c) => c.which !== 'merged').length === 3,
  JSON.stringify(CALLS.map((c) => c.which)));

// ---------- 4) embedding 不可用: 仍只一次调用, 观察层跳过 ----------
console.log('\n--- embedding 不可用 ---');
CALLS.length = 0;
const dbNoEmb = freshDb();
const noEmb = await observeText(dbNoEmb, { llm: makeLlm(), embed: null }, {
  chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS,
});
check('仍是 1 次调用 (没有因为缺 embedding 变成多次)', CALLS.length === 1, String(CALLS.length));
check('合并 prompt 明确要求不要输出 observations (省输出 token)',
  CALLS[0].system.includes('不要输出 observations'), CALLS[0].system.slice(-60));
check('属性层标 skipped 并给原因, 其余两层照常',
  noEmb.steps.attributes.ok === false && noEmb.steps.attributes.skipped === true
  && /embedding/.test(noEmb.steps.attributes.skippedReason)
  && noEmb.steps.instances.ok === true && noEmb.steps.stances.ok === true,
  JSON.stringify(noEmb.steps.attributes));
check('观察层没落库, 事件与立场照常落库',
  dbNoEmb.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === 0
  && dbNoEmb.prepare('SELECT COUNT(*) n FROM events').get().n === 1
  && dbNoEmb.prepare('SELECT COUNT(*) n FROM stances').get().n === 1);
check('partial=true (有层未成功)', noEmb.partial === true);
check('无 embedding 时立场的锚点仍被填上 (锚点不依赖向量能力)',
  dbNoEmb.prepare('SELECT valid_from_event_id v FROM stances').get().v
  === dbNoEmb.prepare('SELECT id FROM events').get().id);

// ---------- 5) split 路径: 共享入参 + 并发 ----------
console.log('\n--- split: 共享入参不变式与并发 ---');
CALLS.length = 0;
const dbSplit = freshDb();
const split = await observeText(dbSplit, { llm: makeLlm(), embed: makeEmbed() }, {
  chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS, characterName: '艾拉', userName: '林',
  mode: 'split',
});
check('显式 split: 三次调用, mode=split',
  CALLS.length === 3 && split.mode === 'split' && split.llmCalls === 3,
  JSON.stringify({ calls: CALLS.length, mode: split.mode }));
check('三步各自成功', ['instances', 'attributes', 'stances'].every((k) => split.steps[k]?.ok === true));
const users = (w) => CALLS.filter((c) => c.which === w).map((c) => c.user);
check('属性步与立场步收到的是文本原文',
  users('attributes')[0] === TEXT && users('stances')[0] === TEXT);
check('事件步的 user 含原文 (身份锚定前缀允许存在)',
  users('instances')[0].includes(TEXT));
check('观察块/立场的来源楼层 = 入参楼层',
  dbSplit.prepare('SELECT source_message_ids s FROM attribute_chunks').get().s === JSON.stringify(FLOORS)
  && dbSplit.prepare('SELECT source_message_ids s FROM stances').get().s === JSON.stringify(FLOORS));
check('split 路径不填事件锚点 (分开抽看不到彼此, 这正是合并存在的理由)',
  dbSplit.prepare('SELECT valid_from_event_id v FROM attribute_chunks').get().v === null);

// 并发性 (只看同时在飞的请求数, 不看墙钟)
{
  let inflight = 0; let peak = 0;
  const slowLlm = {
    describe: () => ({ provider: 'fake', configured: true, model: 'fake' }),
    async chat({ system }) {
      inflight++; peak = Math.max(peak, inflight);
      await new Promise((r) => setTimeout(r, 30));
      inflight--;
      return cannedReply(whichOf(system));
    },
  };
  await observeText(freshDb(), { llm: slowLlm, embed: makeEmbed() }, {
    chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS, mode: 'split',
  });
  check('split 三步并发发出 (同时在飞 ≥ 2)', peak >= 2, `peak=${peak}`);
}

// ---------- 6) 单步失败不中断 (split) ----------
console.log('\n--- split: 单层失败不中断 ---');
CALLS.length = 0;
const dbFail = freshDb();
const failing = await observeText(dbFail, { llm: makeLlm({ failOn: 'attributes' }), embed: makeEmbed() }, {
  chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS, mode: 'split',
});
check('失败的层记 ok:false + error, 不抛到调用方',
  failing.steps.attributes.ok === false && String(failing.steps.attributes.error).includes('故障'));
check('其余两层照常成功且落库',
  failing.steps.instances.ok === true && failing.steps.stances.ok === true
  && dbFail.prepare('SELECT COUNT(*) n FROM events').get().n === 1
  && dbFail.prepare('SELECT COUNT(*) n FROM attribute_chunks').get().n === 0);
check('partial 标记为 true', failing.partial === true);

// ---------- 7) steps 补跑 ----------
console.log('\n--- steps: 只补跑某一层 ---');
CALLS.length = 0;
const dbSteps = freshDb();
const onlyAttr = await observeText(dbSteps, { llm: makeLlm(), embed: makeEmbed() }, {
  chatId: CHAT, text: TEXT, sourceMessageIds: FLOORS, steps: ['attributes'],
});
check('补跑走 split (合并无法只产出一层), 只发一次调用',
  onlyAttr.mode === 'split' && CALLS.length === 1 && onlyAttr.stepsRun.join(',') === 'attributes',
  JSON.stringify({ mode: onlyAttr.mode, calls: CALLS.length, run: onlyAttr.stepsRun }));
check('未指定的层不出现在报告里', onlyAttr.steps.instances === undefined);
check('补跑同样带上共享来源楼层',
  dbSteps.prepare('SELECT source_message_ids s FROM attribute_chunks').get()?.s === JSON.stringify(FLOORS));

let threw = null;
try {
  await observeText(dbSteps, { llm: makeLlm(), embed: makeEmbed() }, { chatId: CHAT, text: TEXT, steps: ['nope'] });
} catch (err) { threw = err.message; }
check('未知层名直接报错', typeof threw === 'string' && threw.includes('未知的抽取步'), String(threw));

// ---------- 8) 入参校验 ----------
console.log('\n--- 入参校验 ---');
const bad = async (opts, clients = { llm: makeLlm(), embed: makeEmbed() }) => {
  try { await observeText(dbSteps, clients, opts); return null; }
  catch (err) { return err.message; }
};
check('chatId 必填', (await bad({ text: TEXT }))?.includes('chatId'));
check('text 不能为空', (await bad({ chatId: CHAT, text: '   ' }))?.includes('text'));
check('LLM 未初始化时报错 (与单步端点同口径)',
  (await bad({ chatId: CHAT, text: TEXT }, { llm: null, embed: makeEmbed() }))?.includes('LLM'));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
