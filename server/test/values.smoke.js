// 取值元素层 + 槽位模型冒烟测试 (V7, docs/verb-layer.md §16)
// 运行: node test/values.smoke.js
//
// 用户提出的前提: **元素先于指针** —— 指针只能指向网中已存在的元素。
// 于是取值也必须是元素 (不是随手写的自由字符串), 走与实体相同的 find-or-create + 别名归并。
// 本套钉住:
//   1) 取值元素的 find-or-create / 别名归并 / 跨域同名分离 / 层级;
//   2) **建立 vs 迁移的判定**: 目标元素不存在 => 建立 (created=true); 存在 => 迁移合法;
//   3) 三种结构操作在槽位上的表现: 建立 (写一次) / 迁移 (只挪指针) / 确认 (不新增行);
//   4) 接线: 写入立场与观察块时, 取值元素被自动登记;
//   5) 归并策略: 宁可不并 (只有显式给别名才并)。
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { migrate, getSchemaVersion } from '../src/db/migrate.js';
import { findOrCreateValue, findValue, listValues } from '../src/services/valueService.js';
import { applyStance, currentSlotStance, evolutionOf } from '../src/services/stanceService.js';
import { addChunk } from '../src/services/chunkService.js';
import { findOrCreatePerson } from '../src/services/entityService.js';
import { stanceSlots, slotSummary } from '../src/services/slotService.js';
import { SLOT_MODEL } from '../src/domain/constants.js';

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

console.log('\n--- ① 取值元素: find-or-create / 别名归并 / 域隔离 ---');
const trust = findOrCreateValue(db, { name: '信任', kind: 'stance_type' });
check('首次出现 => created=true (这是"建立", 不是迁移)',
  trust.created === true && trust.existed === false, JSON.stringify(trust));
const trustAgain = findOrCreateValue(db, { name: '信任', kind: 'stance_type' });
check('再次出现 => 复用同一元素 (created=false)', trustAgain.id === trust.id && trustAgain.created === false);
const byAlias = findOrCreateValue(db, { name: '信赖', aliases: [], kind: 'stance_type' });
check('未登记的写法是**另一个元素** (指向不同文本 = 没指向同一元素)',
  byAlias.id !== trust.id, `${trust.id} vs ${byAlias.id}`);

const merged = findOrCreateValue(db, { name: '信任', aliases: ['信赖', '信服'], kind: 'stance_type' });
check('显式给出别名 => 归并进同一元素',
  merged.id === trust.id && JSON.parse(merged.aliases).includes('信赖'), merged.aliases);
check('归并后按别名也能查到', findValue(db, { name: '信服', kind: 'stance_type' })?.id === trust.id);

const guarded = findOrCreateValue(db, { name: '信任', aliases: ['托付'], kind: 'stance_type', mergeAliases: false });
check('mergeAliases=false => 只查不并 (归属语境下的安全用法)',
  !JSON.parse(guarded.aliases).includes('托付'), guarded.aliases);
check('宁可不并: 未显式声明的写法保持为独立元素',
  findValue(db, { name: '托付', kind: 'stance_type' }) === null);

const sameNameOtherKind = findOrCreateValue(db, { name: '信任', kind: 'aspect' });
check('同名不同域 => 两个元素 (跨域不同语义)',
  sameNameOtherKind.id !== trust.id && sameNameOtherKind.created === true);

const child = findOrCreateValue(db, { name: '亲近', kind: 'stance_type', parentName: '信任' });
check('校验不了父子关系时仍可建 (parent 只作层级提示, 不影响指针)',
  child.id !== trust.id && child.parent_id != null, JSON.stringify(child));

console.log('\n--- ② 接线: 写入立场/观察块时取值元素被自动登记 ---');
const ella = findOrCreatePerson(db, { name: '艾拉' }).id;
const hero = findOrCreatePerson(db, { name: '主角' }).id;
const st1 = applyStance(db, {
  holderType: 'person', holderId: ella, targetType: 'person', targetId: hero,
  stanceType: '戒备', chatId: 'chat-v7',
});
check('写入立场时自动登记取值元素',
  findValue(db, { name: '戒备', kind: 'stance_type' }) != null);
check('槽位为空 => 建立 (operation=create)', st1.operation === 'create', st1.operation);

addChunk(db, { entityType: 'person', entityId: ella, aspect: 'personality', content: '遇事先观察', chatId: 'chat-v7' });
check('写入观察块时自动登记维度元素 (kind=aspect)',
  findValue(db, { name: 'personality', kind: 'aspect' }) != null);

console.log('\n--- ③ 三种结构操作 (指针语义的落点) ---');
// 确认: 值没变 -> 不新增行
const before = db.prepare('SELECT COUNT(*) n FROM stances').get().n;
const st2 = applyStance(db, {
  holderType: 'person', holderId: ella, targetType: 'person', targetId: hero,
  stanceType: '戒备', intensity: 0.3, chatId: 'chat-v7',
});
check('确认: 不新增行 (文本零膨胀)',
  st2.operation === 'confirm' && st2.id === st1.id
  && db.prepare('SELECT COUNT(*) n FROM stances').get().n === before,
  JSON.stringify(st2));
check('确认计数落库', db.prepare('SELECT confirms FROM stances WHERE id = ?').get(st1.id).confirms === 1);

// 迁移: 值变了 -> 新行 + 指针指向前驱
const st3 = applyStance(db, {
  holderType: 'person', holderId: ella, targetType: 'person', targetId: hero,
  stanceType: '信任', chatId: 'chat-v7',
});
check('迁移: 新行指向前驱, 且记录了来源值',
  st3.operation === 'migrate' && st3.from === st1.id && st3.fromValue === '戒备',
  JSON.stringify(st3));
check('迁移不复制文本: 旧行完好保留 (可回溯), 新行只是一个短值',
  db.prepare('SELECT stance_type FROM stances WHERE id = ?').get(st1.id).stance_type === '戒备');
check('槽位当前值 = 最新值 (指针已移动)',
  currentSlotStance(db, {
    holderType: 'person', holderId: ella, targetType: 'person', targetId: hero, chatId: 'chat-v7',
  }).id === st3.id);
check('演化链可读出 (戒备 → 信任)', evolutionOf(db, st3.id) === '戒备 → 信任', String(evolutionOf(db, st3.id)));

// 不同维度 => 不同槽位 => 可并存
const concurrent = applyStance(db, {
  holderType: 'person', holderId: ella, targetType: 'person', targetId: hero,
  stanceType: '戒备', dimension: '动机', chatId: 'chat-v7',
});
check('不同维度 => 独立槽位 (可并存, 不触发迁移)',
  concurrent.operation === 'create', concurrent.operation);

console.log('\n--- ④ 槽位清单与迁移记录 (从链推导, 不建表) ---');
const slots = stanceSlots(db, { chatId: 'chat-v7' });
check('两个槽位 (总体 / 动机) 各自独立',
  slots.length === 2 && slots.some((s) => s.dimension === '动机'), JSON.stringify(slots.map((s) => s.key)));
const total = slots.find((s) => s.dimension === SLOT_MODEL.stanceDefaultDimension);
check('缺省维度名为 constants 下发值', total.dimension === SLOT_MODEL.stanceDefaultDimension);
check('迁移记录含 create + confirm + migrate',
  ['create', 'confirm', 'migrate'].every((op) => total.transitions.some((t) => t.operation === op)),
  JSON.stringify(total.transitions));
check('确认条目带计数', total.transitions.some((t) => t.operation === 'confirm' && t.count === 1));

const summary = slotSummary(db, { chatId: 'chat-v7' });
check('汇总给出计数与标签 (跨端同源)', summary.counts.migrate >= 1
  && Object.keys(summary.labels).length === SLOT_MODEL.operations.length, JSON.stringify(summary.counts));
check('槽位定义由 constants 下发', summary.slotDefs.length === SLOT_MODEL.slotDefs.length);

console.log('\n--- ⑤ 撤销: 指针置空, 文本仍在 (且不做自动回退) ---');
db.prepare('UPDATE stances SET is_active = 0 WHERE id = ?').run(st3.id);
check('撤销后该槽位无当前值 (指针置空, 行仍在)',
  currentSlotStance(db, {
    holderType: 'person', holderId: ella, targetType: 'person', targetId: hero, chatId: 'chat-v7',
  }) === null);
check('前驱不因撤销而复活 (被覆盖集合从全表算)',
  db.prepare('SELECT COUNT(*) n FROM stances WHERE id = ? AND is_active = 1').get(st1.id).n === 1
  && stanceSlots(db, { chatId: 'chat-v7' }).every((s) => s.dimension !== SLOT_MODEL.stanceDefaultDimension),
  JSON.stringify(stanceSlots(db, { chatId: 'chat-v7' }).map((s) => s.dimension)));

console.log('\n--- ⑥ 取值域清单 ---');
const kinds = listValues(db, { kind: 'stance_type' }).map((v) => v.name);
check('立场类型取值域已登记', kinds.includes('信任') && kinds.includes('戒备') && kinds.includes('亲近'),
  JSON.stringify(kinds));
check('取值域可按 kind 过滤 (aspect 不混入)',
  listValues(db, { kind: 'aspect' }).every((v) => v.kind === 'aspect'));

console.log(failures === 0 ? '\n全部通过' : `\n${failures} 项失败`);
process.exit(failures === 0 ? 0 : 1);
