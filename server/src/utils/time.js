// 时间文案 (V10): **全项目唯一的时间戳格式化处**。
//
// 为什么需要它: 喂给 LLM 的上下文里的**时间位置只放精确时间戳** ——
// 以前那儿是剧情内标签 ("第三夜" / "夜里" / "未定时"), 模型没法把"什么时候"落到具体某一天某一刻。
// 绝对时间的唯一不凭空来源是**记录侧的真实时间**; 严格口径下不再写"约/推断"这类模糊措辞,
// 基准来源只以字段形式上报 (`clockInferred`), 不进 prompt。
//
// 统一用**本地时间**: 要求里有"星期x", 那是给人读的本地日历概念, UTC 会算错星期。
export const WEEKDAY_CN = ['日', '一', '二', '三', '四', '五', '六'];
const pad = (n) => String(n).padStart(2, '0');

/** 收下库里存的**秒**、JS 的**毫秒**、Date 与可解析字符串; 无法解析返回 null */
export function toDate(ts) {
  if (ts == null) return null;
  if (ts instanceof Date) return Number.isNaN(ts.getTime()) ? null : ts;
  if (typeof ts === 'number') {
    if (!Number.isFinite(ts)) return null;
    return new Date(ts < 1e12 ? ts * 1000 : ts);
  }
  const d = new Date(String(ts));
  return Number.isNaN(d.getTime()) ? null : d;
}

/** 完整时间戳: `2026年10月15日星期三 01:23` (年月日星期时分, 月日时分补零) */
export function formatStamp(ts) {
  const d = toDate(ts);
  if (!d) return '';
  return `${d.getFullYear()}年${pad(d.getMonth() + 1)}月${pad(d.getDate())}日`
    + `星期${WEEKDAY_CN[d.getDay()]} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}
