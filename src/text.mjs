// 文本和时间的小工具，几个模块共用。

/** 去掉空白、标点、符号，转小写，用来比较原话。 */
export const norm = s => String(s ?? '').replace(/[\s\p{P}\p{S}]/gu, '').toLowerCase();

/** 二字组集合（中文按字切，够用）。 */
export const grams = s => { const n = norm(s), g = new Set(); for (let i = 0; i + 1 < n.length; i++) g.add(n.slice(i, i + 2)); return g; };

/** g 里有多少比例的字组出现在 t（已 norm）里。 */
export const cover = (g, t) => { let h = 0; for (const x of g) if (t.includes(x)) h++; return g.size ? h / g.size : 0; };

const WEEKDAY = '日一二三四五六';
const toMs = t => typeof t === 'number' ? t : Date.parse(t);

/** 本地时间戳“11-16 周一 20:07”。offset 是时区小时数（北京时间 8）。 */
export function stamp(t, offset = 8) {
  const ms = toMs(t); if (!Number.isFinite(ms)) return '';
  const d = new Date(ms + offset * 3600e3), iso = d.toISOString();
  return `${iso.slice(5, 10)} 周${WEEKDAY[d.getUTCDay()]} ${iso.slice(11, 16)}`;
}

/** 本地日期“2026-11-16”。 */
export const localDay = (t, offset = 8) => { const ms = toMs(t); return Number.isFinite(ms) ? new Date(ms + offset * 3600e3).toISOString().slice(0, 10) : ''; };

/** 本地时间“2026-11-16 20:07”。 */
export const localMinute = (t, offset = 8) => { const ms = toMs(t); return Number.isFinite(ms) ? new Date(ms + offset * 3600e3).toISOString().slice(0, 16).replace('T', ' ') : ''; };

/** ISO 周编号“2026-W47”，按本地时区算。 */
export function weekKey(t, offset = 8) {
  const d = new Date(toMs(t) + offset * 3600e3), wd = (d.getUTCDay() + 6) % 7;
  const mon = Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() - wd);
  const thu = new Date(mon + 3 * 86400e3), y = thu.getUTCFullYear();
  return y + '-W' + String(1 + Math.floor((thu - Date.UTC(y, 0, 1)) / 86400e3 / 7)).padStart(2, '0');
}

/** 默认称呼：笔记是 AI 用第一人称写的，“我”是 AI，user 指用户，ai 是校对时给 AI 那一方的标签。 */
export const DEFAULT_LABELS = Object.freeze({ user: '他', self: '我', ai: '她' });

export function resolveLabels(l = {}) {
  const x = { ...DEFAULT_LABELS, ...l };
  if (new Set([x.user, x.self, x.ai]).size < 3) throw new Error('labels.user / self / ai 三个称呼必须各不相同');
  return x;
}

/** 正则里用的转义。 */
export const esc = s => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
