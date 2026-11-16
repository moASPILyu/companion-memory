// 体检：不调模型，只看文件和事件日志。后台整理悄悄停了、连着失败，平时很难发现，
// 等发现时笔记已经几周没更新了。这里每周看一次，返回报告和提醒。
import fs from 'node:fs';
import path from 'node:path';

const DAY = 86400e3;
const size = p => { try { return fs.statSync(p).size; } catch { return 0; } };
const dirSize = d => { try { return fs.readdirSync(d).reduce((s, n) => s + size(path.join(d, n)), 0); } catch { return 0; } };
const mb = n => (n / 1048576).toFixed(1) + ' MB';

/**
 * rows：流水账；events：事件日志 [{kind, at, ...}]；dir：数据目录；now：当前时间。
 * 返回 {ok, alerts:[文字], md}。
 */
export function healthReport({ rows, events, dir, now = Date.now(), facts = 0 }) {
  const alerts = [], lines = [];
  const last = kind => [...events].reverse().find(e => e.kind === kind);
  const since = t => t ? Math.floor((now - Date.parse(t)) / DAY) : null;
  const week = rows.filter(r => now - Date.parse(r.at) < 7 * DAY).length;
  lines.push(`- 流水账 ${rows.length} 句，最近 7 天 ${week} 句，占 ${mb(dirSize(path.join(dir, 'ledger')))}`);
  lines.push(`- 原话事实 ${facts} 条`);
  // 有聊天却没整理：最近 7 天聊了 30 句以上，笔记 7 天没更新过
  for (const [ok, name, days] of [['note_updated', '了解笔记', 7], ['style_updated', '说话习惯', 7], ['audit_done', '对账', 14]]) {
    const e = last(ok), d = since(e?.at);
    lines.push(`- ${name}：${e ? d + ' 天前' : '还没有'}`);
    if (week >= 30 && (d === null || d > days)) alerts.push(`${name}已经 ${d === null ? '一直没' : d + ' 天没'}更新，最近 7 天聊了 ${week} 句`);
  }
  // 同一项连着失败
  const tail = new Map();
  for (const e of events) {
    const job = e.kind.replace(/_(failed|rejected|updated|done|written|saved)$/, '');
    if (/_(failed|rejected)$/.test(e.kind)) tail.set(job, (tail.get(job) || 0) + 1);
    else if (/_(updated|done|written|saved)$/.test(e.kind)) tail.set(job, 0);
  }
  for (const [job, n] of tail) if (n >= 3) alerts.push(`${job} 连着失败 ${n} 次，看 events.jsonl 里的 reason`);
  const evSize = size(path.join(dir, 'events.jsonl'));
  if (evSize > 32 * 1048576) alerts.push(`事件日志 ${mb(evSize)}，可以按月归档`);
  const md = ['# 记忆体检 ' + new Date(now).toISOString().slice(0, 10), '', ...lines, '', alerts.length ? '## 要注意\n\n' + alerts.map(a => '- ' + a).join('\n') : '没发现问题。', ''].join('\n');
  return { ok: !alerts.length, alerts, md };
}
