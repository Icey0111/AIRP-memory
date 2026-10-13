// 注入表格渲染器 —— 纯函数, 无副作用, 不依赖 db / 配置 / 客户端
//
// 存在理由 (设计依据见 docs/injection-tables.md):
//   注入文本的"整齐"不来自 TypeScript 本身, 而来自三件事, 本文件负责前两件:
//     ① CJK 感知对齐 —— 中文字符显示宽 2 列, padEnd 按码点数对齐必然错位;
//     ② 列定义类型化 —— TableSpec 在编译期约束"漏填单元格 / 列名漂移";
//     (③ 快照测试钉死格式 —— 见 test/tables.smoke.js)
//
// 语法约束 (Node 原生 type stripping, 零构建): 只用可擦除语法 ——
//   禁止 enum / namespace / 参数属性 / 装饰器; 相对导入必须写全 .ts 扩展名。
//   本文件无任何 import, 因此不受第二条影响。
//
// 两种输出形态 (格式口径见 §7):
//   'aligned'  —— 常驻层: 对齐纯文本 (表头 + 分隔行 + 补空格的行)
//   'markdown' —— 检索层: 紧凑管道行, 不对齐、无分隔行 (省 token)

export interface TableColumn {
  /** 取值键: row.cells[key] */
  key: string;
  /** 表头文字 */
  title: string;
  /** 单元格显示宽度上限 (显示宽, 非字节); 留空取 spec.cellMaxWidth */
  maxWidth?: number;
  /** 分组锚点列的 key —— 该列连续重复值自动留空 (同一时间节点只描述一次) */
  // 注: 由 spec.groupKey 统一指定, 列上不再单独声明
}

export interface TableSpec {
  /** 段落标题, 如 '【事件时间线】'; 空行数据时不输出 (空段不出段) */
  header: string;
  columns: TableColumn[];
  /** 输出形态 */
  format: 'aligned' | 'markdown';
  /** 全局单元格截断宽度 (可被列上的 maxWidth 覆盖); 0 / 留空 = 不截断 */
  cellMaxWidth?: number;
  /** 分组锚点列的 key: 同组只在该列第一行显示, 其余留空 (时间节点分组) */
  groupKey?: string;
}

export interface TableRow {
  /** 单元格文本: key -> 已格式化好的字符串 (渲染器不做语义解释) */
  cells: Record<string, string>;
}

// ---------------------------------------------------------------
// 显示宽度 (东亚宽字符简化口径: 全角/中日韩/emoji 计 2, 其余计 1)
// ---------------------------------------------------------------

const WIDE_RANGES: Array<[number, number]> = [
  [0x1100, 0x115f],   // 韩文字母
  [0x2e80, 0x303e],   // 中日韩部首 / 标点
  [0x3041, 0x33ff],   // 假名 / 注音 / 兼容字符
  [0x3400, 0x4dbf],   // 扩展 A
  [0x4e00, 0x9fff],   // 基本汉字
  [0xa000, 0xa4cf],   // 彝文
  [0xac00, 0xd7a3],   // 韩文音节
  [0xf900, 0xfaff],   // 兼容汉字
  [0xfe10, 0xfe19],   // 竖排标点
  [0xfe30, 0xfe6f],   // 兼容形式
  [0xff00, 0xff60],   // 全角 ASCII
  [0xffe0, 0xffe6],   // 全角符号
  [0x1f300, 0x1f64f], // emoji
  [0x1f900, 0x1f9ff],
  [0x20000, 0x2fffd], // 扩展 B+
  [0x30000, 0x3fffd],
];

/** 单个码点的显示宽度 */
export function charWidth(codePoint: number): number {
  for (const [lo, hi] of WIDE_RANGES) {
    if (codePoint >= lo && codePoint <= hi) return 2;
  }
  return 1;
}

/** 字符串显示宽度 (按码点遍历, 无视代理对) */
export function displayWidth(s: string): number {
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    if (cp !== undefined) w += charWidth(cp);
  }
  return w;
}

/** 按显示宽度右侧补空格 (对齐的唯一入口; 不要用 padEnd) */
export function padRight(s: string, width: number): string {
  const gap = width - displayWidth(s);
  return gap > 0 ? s + ' '.repeat(gap) : s;
}

/**
 * 按显示宽度截断, 超长时末尾加省略号。
 * maxWidth <= 0 表示不截断。若 maxWidth 小于省略号宽度, 只保留省略号。
 */
export function truncateToWidth(s: string, maxWidth: number, ellipsis = '…'): string {
  if (maxWidth <= 0 || displayWidth(s) <= maxWidth) return s;
  const budget = Math.max(0, maxWidth - displayWidth(ellipsis));
  let out = '';
  let w = 0;
  for (const ch of s) {
    const cp = ch.codePointAt(0);
    const cw = cp === undefined ? 0 : charWidth(cp);
    if (w + cw > budget) break;
    out += ch;
    w += cw;
  }
  return out + ellipsis;
}

/** markdown 管道行里正文的 | 会破坏结构, 统一替换 (对齐纯文本层无需转义) */
export function escapePipe(s: string): string {
  return s.replace(/\|/g, '／');
}

// ---------------------------------------------------------------
// 行渲染
// ---------------------------------------------------------------

function cellOf(spec: TableSpec, row: TableRow, col: TableColumn, markdown: boolean): string {
  const raw = row.cells[col.key] ?? '';
  const max = col.maxWidth ?? spec.cellMaxWidth ?? 0;
  const cut = truncateToWidth(raw, max);
  return markdown ? escapePipe(cut) : cut;
}

/**
 * 分组锚点列的"同组留空"处理。
 * 连续相同的锚点值只在首行输出, 其余行留空 —— 这正是"同一时间节点只描述一次"。
 * 空值行不改变锚点状态 (允许组内出现无锚点行)。
 */
function suppressGroupColumn(spec: TableSpec, table: string[][]): void {
  if (!spec.groupKey) return;
  const gi = spec.columns.findIndex((c) => c.key === spec.groupKey);
  if (gi < 0) return;
  let last = '';
  for (const line of table) {
    const raw = line[gi];
    if (raw !== '' && raw === last) line[gi] = '';
    if (raw !== '') last = raw;
  }
}

/** 常驻层: 对齐纯文本 (表头 + 分隔行 + 数据行) */
export function renderAligned(spec: TableSpec, rows: TableRow[]): string {
  const cols = spec.columns;
  const table = rows.map((row) => cols.map((c) => cellOf(spec, row, c, false)));
  suppressGroupColumn(spec, table);

  const widths = cols.map((c, i) => {
    let w = displayWidth(c.title);
    for (const line of table) w = Math.max(w, displayWidth(line[i]));
    return w;
  });

  const lines: string[] = [];
  lines.push(cols.map((c, i) => padRight(c.title, widths[i])).join('  ').trimEnd());
  lines.push(cols.map((_, i) => '-'.repeat(widths[i])).join('  ').trimEnd());
  for (const line of table) {
    lines.push(line.map((v, i) => padRight(v, widths[i])).join('  ').trimEnd());
  }
  return lines.join('\n');
}

/** 检索层: 紧凑 markdown 管道行 (不对齐、无分隔行) */
export function renderMarkdown(spec: TableSpec, rows: TableRow[]): string {
  const cols = spec.columns;
  const table = rows.map((row) => cols.map((c) => cellOf(spec, row, c, true)));
  suppressGroupColumn(spec, table);

  const toLine = (vals: string[]) => `| ${vals.join(' | ')} |`;
  const lines: string[] = [];
  lines.push(toLine(cols.map((c) => escapePipe(c.title))));
  for (const line of table) lines.push(toLine(line));
  return lines.join('\n');
}

/**
 * 段落渲染总入口: 空数据不出段 (返回 ''), 否则返回 "标题换行 + 表格"。
 * 渲染异常由调用方兜底 (回退 bullet 路径), 本函数只保证确定性输出。
 */
export function renderTable(spec: TableSpec, rows: TableRow[]): string {
  if (!rows || rows.length === 0) return '';
  const body = spec.format === 'markdown'
    ? renderMarkdown(spec, rows)
    : renderAligned(spec, rows);
  return `${spec.header}\n${body}`;
}

// ---------------------------------------------------------------
// 首现展开 (L3 渲染期去重): 同一名实在一次注入中最多全量描述一次
// ---------------------------------------------------------------

export interface FirstOccurrence {
  /** 首次出现返回 '名字(速写)', 之后只返回 '名字'; 无速写时永远只返回名字 */
  expand(name: string, sketch?: string, maxWidth?: number): string;
  /** 该名实是否已经展开过 */
  seen(name: string): boolean;
  /** 该名实在本次注入中被引用的次数 (复现计数的原料) */
  occurrences(name: string): number;
  reset(): void;
}

/** 建一个"首现展开"追踪器 (一次注入组装建一个, 跨段落共享) */
export function createFirstOccurrenceTracker(): FirstOccurrence {
  const counts = new Map<string, number>();
  const expanded = new Set<string>();
  return {
    expand(name: string, sketch?: string, maxWidth = 12): string {
      if (!name) return '';
      counts.set(name, (counts.get(name) ?? 0) + 1);
      if (expanded.has(name) || !sketch) return name;
      expanded.add(name);
      return `${name}(${truncateToWidth(sketch, maxWidth)})`;
    },
    seen(name: string): boolean {
      return expanded.has(name);
    },
    occurrences(name: string): number {
      return counts.get(name) ?? 0;
    },
    reset(): void {
      counts.clear();
      expanded.clear();
    },
  };
}

/**
 * 复现计数标记 (L2 折叠链头专用): 只对"被反复观察到 N 次"的条目渲染, N<=1 返回空串。
 * 语义是"稳定模式"的证据, 不是噪声 —— 见 §4.3。
 */
export function markRecurrence(n: number, mark = '×'): string {
  return n > 1 ? `${mark}${n}` : '';
}
