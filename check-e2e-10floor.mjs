// 端到端对话模拟: 逐层推进一场 10+N 层的对话, 验证长对话总结闭环的真实行为。
// 运行: node check-e2e-10floor.mjs   (需要 7780 服务已在跑, LLM/embedding 可用)
//
// 它做什么:
//   1. 在内存里模拟酒馆 chat 数组 (mes/is_user/is_system), 每轮推入 用户+角色 两条 (2 层);
//   2. 每轮结束后按前端 summarizer.js 的同一套决策复算: 待总结区间可见楼层数 >= 阈值
//      => POST /api/summarize => 把覆盖边界外的正文标记 is_system (模拟 /hide);
//   3. 阈值/保留数/单批上限/摘要长度全部从 /api/meta 读, 脚本不写死任何语义数字;
//   4. 用独立测试 chatId, 与真实聊天完全隔离; 测完软删测试摘要, 库不留脏数据。
//
// 它验证什么 (项目语义逐条对账):
//   - 触发量纲是楼层数: 第 N 轮 (N=triggerFloors/2) 才触发, 之前每轮都跳过;
//   - 覆盖边界 = 实际进摘要的最后一个楼层 (batchTruncated=false 时即区间末端);
//   - 隐藏边界 = coveredTo - keepRecent, 差额楼层逐字保留;
//   - 摘要落库形状: type=summary / scope=chat / 覆盖楼层溯源 / tags;
//   - 同覆盖楼层集合再调一次 => 去重复用, 不产生第二条;
//   - 【前情提要】常驻在场 (不走相似度): /api/context 必含且按楼层顺序排列;
//   - 检索默认排除 summary (它们走前情提要, 不占检索预算), includeSummaries 才可见;
//   - 前情提要独立预算: 压小预算时保新丢旧、至少留最新。

const BASE = process.env.TM_BASE || 'http://127.0.0.1:7780';
const CHAT_ID = `e2e-10floor-${new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '')}`;
const CHARACTER_ID = '艾拉';

let failures = 0;
let warnings = 0;
function ok(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}
function warn(name, cond, detail = '') {
  // 内容质量类断言: LLM 有随机性, 不达标记警告不算失败
  if (cond) console.log(`  ✓ ${name}`);
  else { console.warn(`  ⚠ ${name} ${detail}`); warnings++; }
}

async function api(method, path, body) {
  const res = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = await res.json().catch(() => null);
  if (!res.ok || data?.ok === false) {
    throw new Error(`${method} ${path} -> ${res.status}: ${data?.error ?? '(无响应体)'}`);
  }
  return data;
}

// ---------------------------------------------------------------
console.log('--- 0. 契约载入 (语义数字全部来自 /api/meta) ---');
const meta = await api('GET', '/api/meta');
const p = meta.summaryPolicy;
const cpt = Number(meta.scoring?.tokenEstimation?.charsPerToken);
ok('summaryPolicy 已下发', Boolean(p), '缺失 -> 前端该功能应整体不可用');
ok('triggerFloors 可用', Number(p.triggerFloors) > 0, `实际 ${p.triggerFloors}`);
ok('keepRecentMessages 可用', Number(p.keepRecentMessages) >= 0, `实际 ${p.keepRecentMessages}`);
ok('keepRecent 应明显小于 triggerFloors (否则总结完几乎不隐藏)',
  Number(p.keepRecentMessages) < Number(p.triggerFloors),
  `${p.keepRecentMessages} vs ${p.triggerFloors}`);
const TRIGGER = Number(p.triggerFloors);
const KEEP = Number(p.keepRecentMessages);
const BATCH_CHARS = Number.isFinite(cpt) && cpt > 0
  ? Math.max(1, Math.trunc(Number(p.maxBatchTokens) * cpt)) : 0;
console.log(`  服务端策略: 触发=${TRIGGER} 层, 保留=${KEEP} 层, 单批=${BATCH_CHARS} 字符`);

// ---------------------------------------------------------------
// 模拟酒馆 chat 数组。一场戏: 夜莺酒馆避雨, 埋了给真 LLM 的语义锚点:
//   戒备->信任的转变 / 承诺(明早结伴去灰烬废塔) / 悬而未决线索(银烛台下落) / 习惯细节(摸耳坠)
const chat = [];   // { mes, is_user, is_system, name }
let summarizedUpTo = -1;
let hiddenUpTo = -1;
const summaryIds = [];   // 每次触发生成的记忆 id
let lastBatch = null;    // 最近一次触发时提交的 {text, ids} (去重测试复用)

function pushFloor(text, isUser) {
  chat.push({ mes: text, is_user: isUser, is_system: false, name: isUser ? '你' : CHARACTER_ID });
}

/** 前端 summarizer.pending() 的同款复算: 区间内可见楼层数 + 严格前缀文本 */
function pending() {
  const from = summarizedUpTo + 1;
  const to = chat.length - 1;
  if (to < from) return { floors: 0, text: '', ids: [], lastIncluded: null };
  const picked = [];
  let chars = 0;
  for (let i = from; i <= to; i++) {
    const m = chat[i];
    if (!m || m.is_system || !String(m.mes).trim()) continue;
    const line = `${m.is_user ? '你' : m.name}: ${m.mes}`;
    if (BATCH_CHARS > 0 && chars + line.length > BATCH_CHARS) break; // 严格前缀
    chars += line.length;
    picked.push({ index: i, line });
  }
  return {
    floors: picked.length,
    text: picked.map((x) => x.line).join('\n'),
    ids: picked.map((x) => String(x.index)),
    lastIncluded: picked.length ? picked[picked.length - 1].index : null,
  };
}

/** 前端 summarizer.run('auto') 的同款决策 */
async function autoCheck() {
  const st = pending();
  if (st.floors < TRIGGER) {
    return { triggered: false, floors: st.floors };
  }
  const res = await api('POST', '/api/summarize', {
    chatId: CHAT_ID,
    characterId: CHARACTER_ID,
    text: st.text,
    sourceMessageIds: st.ids,
    maxChars: Number(p.maxSummaryChars) || null,
  });
  lastBatch = { text: st.text, ids: st.ids, memoryId: res.memoryId };
  const coveredTo = st.lastIncluded ?? (chat.length - 1);
  summarizedUpTo = coveredTo;
  summaryIds.push(res.memoryId);
  // 隐藏覆盖区间里保留线之前的正文 (模拟 /hide 置 is_system)
  let hidden = null;
  const from = hiddenUpTo + 1;
  const to = Math.max(from - 1, coveredTo - KEEP);
  if (to >= from) {
    for (let i = from; i <= to; i++) chat[i].is_system = true;
    hiddenUpTo = to;
    hidden = { from, to, count: to - from + 1 };
  }
  return { triggered: true, report: res, coveredTo, hidden, deduped: res.deduped === true };
}

const ROUNDS = [
  ['这场雨太大了, 我先躲进酒馆, 可以坐你对面的空位吗?', '……随便。但你最好安分点, 夜莺酒馆里什么人都有。'],
  ['你一直按着剑柄, 是在等谁, 还是在防谁?', '防谁? 哈, 这年头活着的精灵都学会了防人。我的事, 与你无关。'],
  ['(一个醉汉摇摇晃晃地凑过去, 一把要去抓艾拉的耳朵) 先生, 放开她。(我拦在他面前把他推了回去)', '……你疯了? 他有刀! ——不过, 谢了。这是今天第二个对我说"放开她"的人。'],
  ['你的耳朵……我什么都没看见。对了, 你刚才一直在看墙上的旧地图, 你在找什么?', '银烛台。教会抄家前从圣殿里失踪的那一座。传闻它最后一次出现, 是在灰烬废塔。'],
  ['明早我也去废塔。两个人搭伴, 总比一个人摸黑强。这是交易, 不是施舍。', '(她把玩着耳坠, 陀螺似的转了一圈又一圈)……成交。明早日出, 酒馆门口。迟到我不等。'],
];

// ---------------------------------------------------------------
console.log(`\n--- 1. 逐层推进, 共 ${ROUNDS.length} 轮 = ${ROUNDS.length * 2} 层 ---`);
for (let r = 0; r < ROUNDS.length; r++) {
  pushFloor(ROUNDS[r][0], true);
  pushFloor(ROUNDS[r][1], false);
  const floorsSoFar = chat.length;
  const result = await autoCheck();
  const expectTrigger = floorsSoFar >= TRIGGER;
  ok(`第 ${floorsSoFar} 层后: ${expectTrigger ? '触发' : '跳过'}总结 (待总结 ${result.floors ?? floorsSoFar} 层)`,
    result.triggered === expectTrigger,
    `实际 triggered=${result.triggered}`);
  if (result.triggered) {
    console.log(`    摘要记忆 #${result.report.memoryId}, 覆盖 [0-${result.coveredTo}], 隐藏 ${JSON.stringify(result.hidden)}`);
    console.log(`    摘要正文: ${result.report.memory?.content}`);
  }
}

// ---------------------------------------------------------------
console.log('\n--- 2. 落库形状对账 ---');
const list = await api('GET', `/api/memories?chatId=${encodeURIComponent(CHAT_ID)}&type=summary`);
ok(`恰好生成 1 条摘要记忆 (共 ${ROUNDS.length} 轮)`, list.memories.length === 1, `实际 ${list.memories.length}`);
const s1 = list.memories[0];
ok('type=summary', s1.type === 'summary');
ok('scope=chat 且 chat_id 正确', s1.scope === 'chat' && s1.chat_id === CHAT_ID);
ok('覆盖楼层 0..(触发-1) 全部落库',
  JSON.stringify(JSON.parse(s1.source_message_ids ?? '[]'))
    === JSON.stringify(Array.from({ length: TRIGGER }, (_, i) => String(i))),
  `实际 ${s1.source_message_ids}`);
ok('importance 取策略默认 0.6 (高于普通事件)', s1.importance === 0.6, `实际 ${s1.importance}`);
ok('隐藏边界 = 覆盖末端 - keepRecent',
  hiddenUpTo === TRIGGER - 1 - KEEP && chat.slice(0, TRIGGER - KEEP).every((m) => m.is_system)
    && chat.slice(TRIGGER - KEEP, TRIGGER).every((m) => !m.is_system),
  `hiddenUpTo=${hiddenUpTo}`);
warn('摘要保留了转变类软信息 (戒备/防备->缓和/谢)',
  /戒备|防|谢/.test(s1.content), s1.content.slice(0, 60));
warn('摘要保留了承诺 (明早/日出/结伴/废塔)',
  /明早|日出|结伴|废塔|交易/.test(s1.content), s1.content.slice(0, 60));
warn('摘要保留了悬而未决线索 (银烛台)',
  /银烛台/.test(s1.content), s1.content.slice(0, 60));

console.log('\n--- 3. 同覆盖楼层再去重 ---');
// 与前端场景对齐: 同一批楼层集合原样再提交一次 (楼层集合非空, 否则服务端无从对账)
const dup = await api('POST', '/api/summarize', {
  chatId: CHAT_ID, text: lastBatch.text, sourceMessageIds: lastBatch.ids,
});
ok('服务端判 deduped=true', dup.deduped === true, `实际 ${dup.deduped}`);
ok('复用同一条记忆', dup.memoryId === s1.id, `${dup.memoryId} vs ${s1.id}`);
const list2 = await api('GET', `/api/memories?chatId=${encodeURIComponent(CHAT_ID)}&type=summary`);
ok('没有产生第二条', list2.memories.length === 1, `实际 ${list2.memories.length}`);

// ---------------------------------------------------------------
console.log('\n--- 4. 注入对账: 前情提要常驻 / 检索排除摘要 ---');
const ctx1 = await api('POST', '/api/context', {
  chatId: CHAT_ID, characterId: CHARACTER_ID,
  query: chat[chat.length - 1].mes,
});
ok('注入文本含【前情提要】段', ctx1.text.includes('【前情提要】'));
ok('前情提要含楼层区间 [0-9]',
  /\[0-9\]/.test(ctx1.text), ctx1.text.split('【前情提要】')[1]?.slice(0, 120));
ok('digestCount=1 / digestDropped=0',
  ctx1.digestCount === 1 && ctx1.digestDropped === 0,
  `count=${ctx1.digestCount} dropped=${ctx1.digestDropped}`);
ok('注入摘要正文与落库一致', ctx1.text.includes(s1.content.slice(0, 30)));

const ret1 = await api('POST', '/api/retrieve', { chatId: CHAT_ID, query: '银烛台 废塔' });
ok('默认检索不含 summary (走前情提要, 不占检索预算)',
  ret1.hits.every((h) => h.type !== 'summary'), JSON.stringify(ret1.hits.map((h) => h.type)));
ok('retrieve 端点自带 digest 调试出口', ret1.digest?.count === 1, `实际 ${ret1.digest?.count}`);
const ret2 = await api('POST', '/api/retrieve', { chatId: CHAT_ID, query: '银烛台 废塔', includeSummaries: true });
ok('includeSummaries=true 时摘要在 FTS 里可见',
  ret2.hits.some((h) => h.type === 'summary'), JSON.stringify(ret2.hits.map((h) => h.type)));

// ---------------------------------------------------------------
console.log('\n--- 5. 前情提要独立预算: 至少留最新 ---');
const ctx2 = await api('POST', '/api/context', {
  chatId: CHAT_ID, query: chat[chat.length - 1].mes, digestMaxTokens: 60,
});
// 此时库里只有 1 条摘要: 无论预算多小都不能空 (至少留最新)
ok('预算 60 token 时仍然在场 (至少留最新)',
  ctx2.digestCount === 1 && ctx2.digestDropped === 0,
  `count=${ctx2.digestCount} dropped=${ctx2.digestDropped}`);
ok('留下的是最新那条 id', ctx2.digestIds[0] === s1.id, `${ctx2.digestIds} vs ${s1.id}`);

// ---------------------------------------------------------------
console.log(`\n--- 6. 再推 ${ROUNDS.length} 轮 (第 ${TRIGGER + 1}~${TRIGGER * 2} 层) -> 第二次触发 ---`);
const ROUNDS2 = [
  ['(次日清晨, 我提着两盏防风灯到门口, 艾拉已经在了, 斗篷下露出短弓的一角)', '你准时。灯给我一盏 —— 废塔里没有光, 火把会暴露位置。'],
  ['(废塔底层, 石阶上覆着厚灰, 你发现灰里有新鲜的脚印, 一直延伸向地下入口)', '不止我们一拨人。脚印是靴底带铁钉的, 教会清剿队的制式。……跟紧我, 别碰任何发光的东西。'],
  ['(地下石室, 你在一具枯骨手里发现半页日记, 提到"烛台沉入了黑水潭")', '黑水潭……塔后岩缝那个? (她抄起日记, 神色第一次真正动摇) 如果这是真的, 银烛台根本不在塔里。'],
  ['那就去黑水潭。你负责看路, 潜水我来 —— 我从小在水边长大。', '(她盯着你看了很久, 忽然低声说) 你到底图什么? 为一个昨天才认识的精灵冒险。'],
  ['图个把事情做完。你找我之前, 也没指望有人会帮你对吧? 我只是刚好顺路。(我把灯举高照向岩缝方向)', '……(她别过脸去, 手指又转起了耳坠, 但这次嘴角是松的) 走吧。潭边见, 别死在半路上。'],
];
for (let r = 0; r < ROUNDS2.length; r++) {
  pushFloor(ROUNDS2[r][0], true);
  pushFloor(ROUNDS2[r][1], false);
  const floorsSoFar = chat.length;
  // 期望值必须按"调用前"的状态推算 (与前端决策同款: 未总结边界 -> 现在 的可见楼层数)
  const expectTrigger = floorsSoFar - summarizedUpTo - 1 >= TRIGGER && floorsSoFar >= TRIGGER;
  const result = await autoCheck();
  ok(`第 ${floorsSoFar} 层后: ${expectTrigger ? '触发' : '跳过'}总结 (未总结可见 ${result.floors ?? '?'} 层)`,
    result.triggered === expectTrigger, `实际 triggered=${result.triggered}`);
  if (result.triggered) {
    console.log(`    摘要记忆 #${result.report.memoryId}, 覆盖 [${result.report.coveredMessageIds[0]}-${result.report.coveredMessageIds.at(-1)}], 隐藏 ${JSON.stringify(result.hidden)}`);
    console.log(`    摘要正文: ${result.report.memory?.content}`);
  }
}

console.log('\n--- 7. 两条摘要链与注入顺序 ---');
const list3 = await api('GET', `/api/memories?chatId=${encodeURIComponent(CHAT_ID)}&type=summary`);
ok('累计 2 条摘要', list3.memories.length === 2, `实际 ${list3.memories.length}`);
const ctx3 = await api('POST', '/api/context', { chatId: CHAT_ID, query: chat[chat.length - 1].mes });
ok('前情提要两条且按楼层顺序排列 ([0-9] 在 [10-19] 前)',
  ctx3.digestCount === 2
  && ctx3.text.indexOf('[0-9]') < ctx3.text.indexOf('[10-19]'),
  `count=${ctx3.digestCount}`);
ok('第二段隐藏边界接上 (keepRecent 层逐字保留)',
  chat.slice(TRIGGER - KEEP, TRIGGER * 2 - KEEP).every((m) => m.is_system)
  && chat.slice(TRIGGER * 2 - KEEP).every((m) => !m.is_system),
  `hiddenUpTo=${hiddenUpTo}`);

const ctx4 = await api('POST', '/api/context', {
  chatId: CHAT_ID, query: chat[chat.length - 1].mes, digestMaxTokens: 60,
});
ok('预算 60 token、两条摘要时: 保新丢旧只留最新 (dropped=1)',
  ctx4.digestCount === 1 && ctx4.digestDropped === 1,
  `count=${ctx4.digestCount} dropped=${ctx4.digestDropped}`);
const newestId = Number(list3.memories.map((m) => m.id).sort((a, b) => b - a)[0]);
ok('留下的确实是最新那条', ctx4.digestIds[0] === newestId, `${ctx4.digestIds} vs ${newestId}`);

// ---------------------------------------------------------------
console.log('\n--- 8. 清理: 软删测试摘要 (可恢复), 库不留脏数据 ---');
for (const m of list3.memories) {
  await api('DELETE', `/api/memories/${m.id}`);
}
const list4 = await api('GET', `/api/memories?chatId=${encodeURIComponent(CHAT_ID)}&type=summary`);
ok('生效摘要清零 (软删, 可用 forget/restore 恢复)', list4.memories.length === 0, `实际 ${list4.memories.length}`);

// ---------------------------------------------------------------
console.log('');
if (failures) {
  console.error(`${failures} 项失败, ${warnings} 项警告`);
  process.exit(1);
}
console.log(`全部通过 (${warnings} 项内容质量警告)`);
