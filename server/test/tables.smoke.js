// 注入表格渲染器冒烟测试 (T0: 纯渲染器, 无 db / 无 HTTP)
// 运行: node test/tables.smoke.js
//
// 这个文件存在的理由 (核心命题):
//   注入文本的"整齐"是一次性交付的格式契约 —— 对齐一旦被后续改动悄悄破坏,
//   LLM 读到的表格就会错列, 而这类回归在别处看不见。
//   所以这里对每种形态做精确快照断言: CJK 对齐 / 分组留空 / 截断 / 转义 / 首现展开 / 空段不出段。
import {
  displayWidth, padRight, truncateToWidth, escapePipe,
  renderAligned, renderMarkdown, renderTable,
  createFirstOccurrenceTracker, markRecurrence,
} from '../src/services/tableRender.ts';

let failures = 0;
function check(name, cond, detail = '') {
  if (cond) console.log(`  ✓ ${name}`);
  else { console.error(`  ✗ ${name} ${detail}`); failures++; }
}

// ===============================================================
console.log('\n--- 显示宽度 (CJK 计 2) ---');
check('ASCII 宽 = 长度', displayWidth('abc') === 3);
check('中文每个字计 2', displayWidth('艾拉') === 4, `得到 ${displayWidth('艾拉')}`);
check('中英混排', displayWidth('艾a拉') === 5, `得到 ${displayWidth('艾a拉')}`);
check('全角标点计 2', displayWidth('（一）') === 6, `得到 ${displayWidth('（一）')}`);
check('emoji 计 2', displayWidth('🌧') === 2, `得到 ${displayWidth('🌧')}`);
check('省略号计 1', displayWidth('…') === 1);
check('空串宽 0', displayWidth('') === 0);

// ===============================================================
console.log('\n--- 补空格 / 截断 ---');
check('padRight 按显示宽度补齐', padRight('艾', 5) === '艾   ', JSON.stringify(padRight('艾', 5)));
check('padRight 不截断超宽内容', padRight('艾拉艾拉', 4) === '艾拉艾拉');
check('短内容不截断', truncateToWidth('酒馆初遇', 10) === '酒馆初遇');
check('maxWidth<=0 表示不截断', truncateToWidth('酒馆初遇', 0) === '酒馆初遇');
check('按显示宽度截断, 不切半个汉字',
  truncateToWidth('嘴上嘲讽, 但主角遇险时会挡在前面', 6) === '嘴上…',
  JSON.stringify(truncateToWidth('嘴上嘲讽, 但主角遇险时会挡在前面', 6)));
check('截断后显示宽度不超过上限',
  displayWidth(truncateToWidth('嘴上嘲讽, 但主角遇险时会挡在前面', 6)) <= 6);
check('英文按 1 列截断', truncateToWidth('ABCDEFGHIJ', 5) === 'ABCD…',
  JSON.stringify(truncateToWidth('ABCDEFGHIJ', 5)));

// ===============================================================
console.log('\n--- 常驻层: 对齐纯文本 (含 CJK + 时间节点分组) ---');
const TIMELINE = {
  header: '【事件时间线】',
  format: 'aligned',
  groupKey: 'time',
  columns: [
    { key: 'time', title: '时间节点' },
    { key: 'event', title: '事件' },
    { key: 'who', title: '参与者' },
    { key: 'where', title: '地点' },
  ],
};
const timelineRows = [
  { cells: { time: '第三夜, 暴雨 #7', event: '酒馆初遇', who: '主角, 艾拉', where: '酒馆' } },
  { cells: { time: '第三夜, 暴雨 #7', event: '卷宗失窃', who: '艾拉', where: '档案馆' } },
  { cells: { time: '第四日 #8', event: '两人对质', who: '艾拉, 主角', where: '档案馆' } },
];

const timeline = renderTable(TIMELINE, timelineRows);
const tLines = timeline.split('\n');
check('首行是段落标题', tLines[0] === '【事件时间线】', tLines[0]);
check('对齐快照逐字符一致 (中文 2 列对齐, 同组锚点留空)', timeline === [
  '【事件时间线】',
  '时间节点         事件      参与者      地点',
  '---------------  --------  ----------  ------',
  '第三夜, 暴雨 #7  酒馆初遇  主角, 艾拉  酒馆',
  '                 卷宗失窃  艾拉        档案馆',
  '第四日 #8        两人对质  艾拉, 主角  档案馆',
].join('\n'), `\n--- 实际 ---\n${timeline}\n------------`);

// 列起点按显示宽度推进: 15 -> 17 -> 27 -> 39 (若用 padEnd 按码点补齐, 这里必然错位)
function fromOffset(line, offset) {
  let off = 0;
  let out = '';
  for (const ch of line) {
    if (off >= offset) out += ch;
    off += displayWidth(ch);
  }
  return out;
}
check('分隔行每列宽度 = 各列最大显示宽度', (() => {
  const segs = tLines[2].split(/ {2,}/);
  return segs.length === 4
    && segs[0].length === 15 && segs[1].length === 8 && segs[2].length === 10 && segs[3].length === 6;
})(), tLines[2]);

check('同组第二行锚点留空 (同一时间节点只描述一次)', tLines[4].startsWith(' '), JSON.stringify(tLines[4]));
check('事件列在所有行落在同一显示列上 (CJK 对齐正确)',
  fromOffset(tLines[3], 17).startsWith('酒馆初遇')
  && fromOffset(tLines[4], 17).startsWith('卷宗失窃')
  && fromOffset(tLines[5], 17).startsWith('两人对质'),
  [fromOffset(tLines[3], 17), fromOffset(tLines[4], 17), fromOffset(tLines[5], 17)].join(' / '));
check('参与者列在所有行落在同一显示列上',
  fromOffset(tLines[3], 27).startsWith('主角, 艾拉')
  && fromOffset(tLines[4], 27).startsWith('艾拉')
  && fromOffset(tLines[5], 27).startsWith('艾拉, 主角'));
check('地点列在所有行落在同一显示列上',
  fromOffset(tLines[3], 39).startsWith('酒馆')
  && fromOffset(tLines[4], 39).startsWith('档案馆'));

// 分组关闭时, 重复值照常渲染 (renderAligned 无段落标题: 0=表头 1=分隔 2..=数据)
const noGroup = renderAligned({ ...TIMELINE, groupKey: undefined }, timelineRows).split('\n');
check('未声明 groupKey 时重复值不省略',
  noGroup[2].includes('第三夜, 暴雨 #7') && noGroup[3].includes('第三夜, 暴雨 #7'),
  JSON.stringify(noGroup.slice(2)));

// ===============================================================
console.log('\n--- 检索层: 紧凑 markdown 行 (不对齐, 无分隔行) ---');
const MEMO = {
  header: '【相关记忆】',
  format: 'markdown',
  columns: [
    { key: 'type', title: '类型' },
    { key: 'time', title: '剧情时间' },
    { key: 'content', title: '内容' },
    { key: 'floor', title: '楼层' },
  ],
};
const memo = renderTable(MEMO, [
  { cells: { type: 'fact', time: '第三夜', content: '主角是左撇子', floor: '12' } },
  { cells: { type: 'event', time: '第四日', content: '卷宗不翼而飞 | 无人目击', floor: '18' } },
]);
check('markdown 快照一致 (无分隔行, 管道符已转义)', memo === [
  '【相关记忆】',
  '| 类型 | 剧情时间 | 内容 | 楼层 |',
  '| fact | 第三夜 | 主角是左撇子 | 12 |',
  '| event | 第四日 | 卷宗不翼而飞 ／ 无人目击 | 18 |',
].join('\n'), `\n--- 实际 ---\n${memo}\n------------`);
check('markdown 形态没有分隔行',
  !memo.split('\n').some((l) => /^\|[\s-|]+\|$/.test(l)));
check('正文里的 | 被替换为 ／ (不破坏列结构)',
  memo.includes('／') && !memo.includes('不翼而飞 | 无人目击'));
check('行内列数恒定', memo.split('\n').slice(1).every((l) => l.split('|').length === 6),
  JSON.stringify(memo.split('\n').slice(1)));

check('escapePipe 只换管道符', escapePipe('a|b') === 'a／b' && escapePipe('a/b') === 'a/b');

// ===============================================================
console.log('\n--- 单元格截断 (列级覆盖全局) ---');
const CHUNKS = {
  header: '【相关细节】',
  format: 'markdown',
  cellMaxWidth: 60,
  columns: [
    { key: 'entity', title: '实体' },
    { key: 'aspect', title: '维度' },
    { key: 'content', title: '观察', maxWidth: 8 },
  ],
};
const chunks = renderTable(CHUNKS, [
  { cells: { entity: '艾拉', aspect: 'personality', content: '嘴上嘲讽, 但主角遇险时会下意识挡在前面' } },
]);
check('列级 maxWidth 生效 (全局 60 被 8 覆盖)', chunks.includes('嘴上嘲…'), `\n${chunks}`);
check('短单元格不受影响', chunks.includes('| 艾拉 | personality |'), `\n${chunks}`);

// ===============================================================
console.log('\n--- 空段不出段 ---');
check('无数据时返回空串 (连标题都不输出)', renderTable(TIMELINE, []) === '');
check('无数据时 markdown 同样为空', renderTable(MEMO, []) === '');
check('单元格缺失按空串处理', renderTable(MEMO, [{ cells: { type: 'fact' } }])
  === '【相关记忆】\n| 类型 | 剧情时间 | 内容 | 楼层 |\n| fact |  |  |  |',
  JSON.stringify(renderTable(MEMO, [{ cells: { type: 'fact' } }])));

// ===============================================================
console.log('\n--- 首现展开 (同一名实在一次注入中最多全量描述一次) ---');
const fo = createFirstOccurrenceTracker();
check('首次出现带速写', fo.expand('艾拉', '银发档案员') === '艾拉(银发档案员)');
check('第二次出现只留名字', fo.expand('艾拉', '银发档案员') === '艾拉');
check('无速写时永远只有名字', fo.expand('酒馆') === '酒馆' && fo.expand('酒馆', '') === '酒馆');
check('复现计数可查 (L2 ×N 的原料)', fo.occurrences('艾拉') === 2 && fo.occurrences('酒馆') === 2);
check('seen 标记如实', fo.seen('艾拉') === true && fo.seen('酒馆') === false);
check('速写按显示宽度截断', (() => {
  const t = createFirstOccurrenceTracker();
  return t.expand('某人', 'ABCDEFGHIJKLMNOP') === '某人(ABCDEFGHIJK…)';
})(), createFirstOccurrenceTracker().expand('某人', 'ABCDEFGHIJKLMNOP'));
check('速写可自定义上限', (() => {
  const t = createFirstOccurrenceTracker();
  return t.expand('某人', '银发档案员', 4) === '某人(银…)';
})(), createFirstOccurrenceTracker().expand('某人', '银发档案员', 4));
fo.reset();
check('reset 后重新展开', fo.expand('艾拉', '银发档案员') === '艾拉(银发档案员)'
  && fo.occurrences('艾拉') === 1);
check('空名返回空串 (不产出空括号)', fo.expand('') === '');

// ===============================================================
console.log('\n--- 复现计数标记 ---');
check('×N 只在复现时出现', markRecurrence(3) === '×3' && markRecurrence(1) === '' && markRecurrence(0) === '');
check('标记可参数化 (与 constants 同源时由此传入)', markRecurrence(2, 'x') === 'x2');

// ===============================================================
console.log('\n--- 确定性 (同一输入两次渲染逐字节一致) ---');
check('aligned 确定', renderTable(TIMELINE, timelineRows) === renderTable(TIMELINE, timelineRows));
check('markdown 确定', renderTable(MEMO, memo === '' ? [] : [{ cells: { type: 'fact', time: '第三夜', content: '主角是左撇子', floor: '12' } }])
  === renderTable(MEMO, [{ cells: { type: 'fact', time: '第三夜', content: '主角是左撇子', floor: '12' } }]));

// ===============================================================
console.log('');
if (failures) {
  console.error(`${failures} 项失败`);
  process.exit(1);
}
console.log('全部通过');
