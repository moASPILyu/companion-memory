// 读 chat.txt：每行“月-日 时:分 他|她 内容”，时间按 offset 时区理解，返回 [{role, text, at}]。
import fs from 'node:fs';

export function loadChat(file, { year = 2026, offset = 8, user = '他', ai = '她' } = {}) {
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^(\d{2})-(\d{2}) (\d{2}):(\d{2}) (\S+) (.+)$/);
    if (!m) continue;
    const [, mo, d, h, mi, who, text] = m;
    if (who !== user && who !== ai) throw new Error('不认识的说话人：' + line);
    const ms = Date.UTC(year, mo - 1, d, h, mi) - offset * 3600e3;
    out.push({ role: who === user ? 'user' : 'assistant', text, at: new Date(ms).toISOString() });
  }
  return out;
}
