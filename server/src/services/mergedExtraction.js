// 合并抽取: **一次 LLM 调用**产出三层(事件要素 / 属性观察 / 关系立场), 分区落库。
//
// 为什么必须合并 (不是省 token, 是恢复跨层关联):
//   分开抽时, 属性步与立场步看不到事件步刚抽出的实例 —— 于是 schema 里留的
//   `valid_from_event_id`(这条观察/立场是被哪个事件触发的)在自动路径上**永远为空**,
//   三层之间只剩 source_message_ids(楼层)这条弱连接。立场答不出"因为哪件事她开始戒备",
//   属性答不出"她是在哪个时间点变成这样的"。
//   合并成一次阅读后, 模型可以在同一次输出里用 `event: "<实例 label>"` 引用自己刚抽的实例,
//   服务端据此把锚点填上。这是分开抽物理上做不到的 —— 信息不在它的上下文里。
//
// 落库复用三个既有写入段 (persistInstances / persistObservations / persistStances):
//   一次调用省下的往返, 不能又在落库层被复制一遍。
//
// 失败策略: 本模块**只负责一次调用**。整份解析失败时抛错, 由 observeService 决定降级
//   (降级到三步并行路径), 保持"保命"能力留在编排层。
//
// 条款漂移的守卫: 三层判据在单步 prompt 里各有一份 (那是给单步端点与降级路径用的)。
//   本文件的 MERGED_PROMPT 必须与它们保持同样的硬条款 —— 由 observe.smoke 的
//   "合并 prompt 与单步 prompt 共有关键条款" 断言看守, 只改一处会被测试抓到。
import {
  parseJsonLoose, persistInstances, buildIdentityAnchor,
} from './extractionService.js';
import { persistObservations } from './chunkExtractionService.js';
import { persistStances } from './stanceExtractionService.js';
import { alignPropositions } from './alignmentService.js';
import {
  CHUNKABLE_ENTITY_TYPES, LLM_LIMITS, VERB_LAYER, VOCABULARY_WORDS,
} from '../domain/constants.js';

// 词表**从 constants 注入 prompt**(单一语义源): 词表抄进 prompt 就会漂移,
// 而模型看不到词表时必然自造 —— 实测 40 条实例 33 个谓词、复用度 1.21 就是这么来的。
const VERB_LIST = VOCABULARY_WORDS.predicate.join('/');
const ROLE_LIST = VERB_LAYER.thematicRoles.map((r) => r.value).join(' 或 ');
const ATTITUDE_LIST = VERB_LAYER.attitudes.map((a) => a.value).join('/');
const ASPECT_LIST = VOCABULARY_WORDS.aspect.join('/');

/**
 * 合并抽取的指令。
 *
 * 三层判据原样保留了各自的硬条款 (身份锚定/原样重复/事件正文正交性/立场有向与二阶),
 * 但输出改成**分区**: 一个 JSON, 四个顶层键。每条属性与立场可以用 `event` 键引用
 * 同一份输出里 instances 的 label —— 这是合并相对于分步的全部意义。
 */
export const MERGED_PROMPT = `你是角色扮演剧情的**一次性记忆抽取器**。读同一段剧情, 同时产出四类内容, 严格输出 JSON, 不要输出任何其他文字。
输出结构 (四个顶层键, 缺哪类就给空数组):
{
  "people": [ { "name": "人物名(用剧情中的称呼)", "aliases": ["其他称呼"], "person_type": "main 或 npc 或 mentioned" } ],
  "locations": [ { "name": "地点名", "parent": "上级地点或 null" } ],
  "time_point": { "label": "剧情时间点(如 第二天清晨)", "chapter": "章节名或 null" } 或 null,
  "instances": [
    { "label": "本批内唯一短标签(如 e1)", "verb_type": "动词(见下方动词表)", "title": "事件标题",
      "tense": "past 或 present 或 future", "polarity": "affirmative 或 negative",
      "source_type": "narrator 或 attributed", "source_name": "归属者(attributed 时填, 否则 null)",
      "attitude": "情态(${ATTITUDE_LIST}, 没有则 null)", "caused_by": "上游实例 label 或 null",
      "participants": [ { "name": "参与者", "role": "${ROLE_LIST}" } ],
      "result_note": "结果或经过(可为空)",
      "comp": { "同 instances 的结构": "从句/引述内容" } 或 null,
      "conditional": { "同 instances 的结构": "条件前件(如果…)" } 或 null,
      "alternatives": [ { "同 instances 的结构": "择一候选(要么A要么B)" } ] 或 null }
  ],
  "observations": [
    { "entity_type": "${CHUNKABLE_ENTITY_TYPES.join(' 或 ')}", "entity_name": "实体名",
      "aspect": "维度(${ASPECT_LIST}; 中文写法亦可, 会被归一)",
      "content": "一条观察一句话, 保留原文细节, 不要总结掉具体信息", "importance": 0.0到1.0,
      "event": "本批 instances 里触发这条观察的 label, 没有就 null" }
  ],
  "stances": [
    { "holder_type": "person 或 org", "holder_name": "立场主体", "target_type": "person 或 org", "target_name": "立场对象",
      "stance_type": "立场类型(信任/戒备/敌对/友好/爱慕/忠诚/敬畏/轻蔑, 不限于此)",
      "intensity": 0.0到1.0, "displayed_type": "对外表现的立场(表里如一填 null)",
      "is_public": true或false, "target_aware": true或false,
      "basis": "依据一句话", "importance": 0.0到1.0,
      "event": "本批 instances 里触发这条立场的 label, 没有就 null" }
  ]
}

**动词表 (verb_type 只能从这里挑, 且必须是一个词)**: ${VERB_LIST}
选不到合适的就用最接近的上位类 (言语/感知/位移/交互/给予/取用/攻防/救助/隐瞒/心理/状态);
只有确实没有对应词时才自造 —— 自造的也必须是**单个动词**, 绝不写短语:
「拦截盘查」「给出最后机会」「出示凭据」这类把**对象也塞进动词**的写法是错的, 对象属于 participants。
动词只回答"做了什么": 谁/何时/何地/对谁 一律由字段与 participants 表达。

分区判据 (互不越界, 这是四类内容能不能共存于一次输出的关键):
- instances: 谁—动词—谁。**时间、人物、地点一律不写进事件正文**(它们由字段与边表达);
  "说话/传话/转述"内容是**从句**(放 comp), 不是叙述者事实 —— 只有叙述者断言才算事实,
  角色的意图/承诺/计划/威胁一律 source_type="attributed"(它们尚未发生, 不可当既成事实);
  只有叙述者断言才能触发人物别名归并。
  **attributed 必须有 comp**: 归属实例的价值全在"内容是什么"上, 内容只在 title 里就等于没抽;
  宿主(说/问/承诺…)自己不参与事实匹配, 匹配由从句去做。
- observations: 细粒度属性观察。**反复出现的日常行为是观察不是事件**("又去小卖部"→ aspect=habit);
  同一条观察在不同时间反复出现时**照原样重复输出**(不要改写、不要加"又一次"): 写入管线按规范化文本判等,
  一字不差只累加计数、措辞变了才算值变了 —— 所以照原样重复最有价值。
- stances: 有向立场( A对B 与 B对A 是两条)。只抽剧情中有依据的, 不要臆测;
  表里不一时填 displayed_type 与 is_public/target_aware。
- event 键: **能对上就填**同一份输出里 instances 的 label; 对不上就填 null, 不要编造。

逻辑关系 (三种, 各有专属结构; 用错会直接编造未发生的事):
- **或 / 择一**: 「要么A要么B」「是A还是B」「不是A就是B」必须用 **alternatives** 表达(两个候选各自一条),
  **绝不能抽成两条并行实例** —— 那等于说两件事都发生了。后续由对齐竞争: 谁被证实谁兑现, 另一个作废。
- **是否疑问**: 「她问他是否来了」「他不知道她走没走」= 宿主 attitude="问" 或 "不知",
  且 alternatives 给**同一件事的正反两个候选**(一个 polarity=affirmative, 一个 negative)。
- **条件**: 「如果A就B」「只要A就B」→ 后果实例带 **conditional**(前件 A)。
  威胁本质是条件命题(「你不做X, 我就做Y」), 同样用 conditional, 不要当成已发生的事实。
- 合取("并且")不需要结构: 同一时间点的多条实例天然读作"并且"。
- 否定用 polarity=negative, 不要自造反义动词。

补充: "谁说了什么"里, 若叙述者随后确认了内容为真, 用 source_type="narrator" 单独写一条实例,
不要改原来那条归属实例的 source_type。`;

/** 分区 id (与单步管线同名, 便于编排层用同一套 keys 汇报) */
export const MERGED_ZONES = ['instances', 'observations', 'stances'];

/**
 * 一次调用完成三层抽取并落库。
 *
 * @param {object} opts
 * @param {boolean} [opts.omitObservations] 环境没有 embedding 时置 true:
 *   直接让模型不产出 observations —— 省下的不是调用次数(仍是一次), 而是**输出 token**
 *   与被丢弃的无效结果。
 * @returns 分区结果 + 实例 label 索引 (供调用方/测试核对锚点)
 */
export async function extractAll(db, { llm, embed }, {
  chatId, text, sourceMessageIds = [], characterName = null, userName = null,
  writeMemory = true, omitObservations = false,
} = {}) {
  if (!chatId) throw new Error('chatId 必填');
  if (!text || !text.trim()) throw new Error('text 不能为空');

  const anchor = buildIdentityAnchor({ characterName, userName });
  const system = omitObservations
    ? `${MERGED_PROMPT}\n\n注意: 本环境未配置向量能力, **不要输出 observations**(给空数组即可)。`
    : MERGED_PROMPT;

  // ===== 唯一的一次 LLM 调用 =====
  // 输出预算必须按**抽取档**给, 不能用会话档: 合并输出是五个分区 (事件可能有嵌套从句),
  // 2026-10-14 实测踩过 —— 走会话档 (config.llm.maxTokens=2048) 时输出在 observations
  // 中途被截断, stances 整段消失, 而且**测试全绿**(假 LLM 不会截断), 只有真实模型才暴露。
  const raw = await llm.chat({
    system,
    user: anchor ? `${anchor}\n\n---\n\n${text}` : text,
    maxTokens: LLM_LIMITS.extractionMaxTokens,
  });
  const data = parseJsonLoose(raw);   // 解析失败会抛错 → 由编排层决定降级

  // 缺哪个分区如实上报: 输出被截断与"这段剧情确实没有该层内容"在数据上长得一样,
  // 所以只报"模型没给这个键", 由调用方决定要不要用 steps 补跑那一层 —— 不猜。
  const missingZones = ['people', 'instances', 'observations', 'stances']
    .filter((k) => data[k] === undefined);

  // 分区落库: 事件先落(它产出 label 索引), 属性与立场随后引用它填锚点
  const zone = {};
  zone.instances = db.transaction(() => persistInstances(db, data, {
    chatId, sourceMessageIds, writeMemory, characterName, userName,
  }))();
  const labels = zone.instances.labels ?? {};

  zone.observations = omitObservations
    ? { chunks: [], skipped: 0, omitted: true }
    : await persistObservations(db, {
      embed, chatId, observations: data.observations ?? [], sourceMessageIds, labels,
    });

  zone.stances = persistStances(db, {
    chatId, stances: data.stances ?? [], sourceMessageIds, labels,
  });

  // ===== 写入后立即对齐 (V10 修正) =====
  // 这里曾经是**真假判定的缺口**: alignPropositions 只在单步 extractInstances 里调用,
  // 而 dsh 的活跃路径走的是本文件 -> persistInstances, 于是"对齐一次都没跑过"
  // (实测: 10 条归属命题, 判定成功 0 条, 全部停在 pending)。
  // 与单步路径同一条纪律: 对齐失败只 warn, 绝不拖垮抽取本身。
  let aligned = null;
  try {
    aligned = alignPropositions(db, { chatId });
  } catch (err) {
    console.warn(`[alignment] 合并抽取后对齐失败, 本轮跳过: ${err.message}`);
  }

  return {
    zone,
    labels,
    aligned,
    /** 模型输出里**没有出现**的分区键 (截断与"确实没有"在数据上同形, 只如实上报, 不猜原因) */
    missingZones,
    /** 本次输出实际产出的分区规模 (0 也是有效信息: 说明这段剧情确实没有该层内容) */
    zones: {
      people: zone.instances.people.length,
      locations: zone.instances.locations.length,
      instances: zone.instances.instances.length,
      links: zone.instances.links.length,
      observations: zone.observations.chunks.length,
      stances: zone.stances.stances.length,
    },
    /** 锚点命中情况: 有多少条观察/立场真的挂到了事件上 (0 且本应有值 = 提示模型没填 event 键) */
    anchored: {
      observations: zone.observations.chunks.filter((c) => c.eventId != null).length,
      stances: zone.stances.stances.filter((s) => s.eventId != null).length,
    },
  };
}
