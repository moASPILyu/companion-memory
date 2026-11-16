// 说话人检查：不调模型，只拿流水账比原话。
//
// 陪伴型 AI 整理“我对他的了解”时，最常见的错是把自己说过的话、自己的爱好记到用户头上
// （“他走再远也说‘这趟值了’”，其实这句是 AI 说的，他只回了“好哦”）。
// 一旦写进笔记，下次整理就当底稿照抄，可以跟着几十个版本一直错下去。
//
// 这里查两种：
//   1. 引号里的原话，在聊天里只有 AI 说过、用户一次都没说过；
//   2. 没加引号的转述“他说/他问/他答应……”，和 AI 某句原话高度重合，和用户说过的都不像。
// 视频标题、图片上的字也会被列出来（AI 念过、用户没打字），所以只用来提醒重写，不硬拒。
import { norm, grams, cover, esc, resolveLabels } from './text.mjs';

const isUser = r => r.role === 'user';

/** 引号原话：note 里有、previous 里没有、聊天里只有 AI 说过。返回 [{quote, text}]，text 是 AI 那句原话。 */
export function aiOnlyQuotes(note, previous, rows, max = 12) {
  const prev = norm(previous || '');
  const normed = rows.map(r => [r.role, norm(r.text), r.text]);
  const seen = new Set(), out = [];
  for (const m of String(note).matchAll(/“([^”]{2,80})”/g)) {
    const q = norm(m[1]);
    if (q.length < 3 || seen.has(q) || prev.includes(q)) continue;
    seen.add(q);
    const hits = normed.filter(([, t]) => t.includes(q));
    if (hits.length && !hits.some(([role]) => role === 'user')) {
      out.push({ quote: m[1], text: String(hits.at(-1)[2]).replace(/\s+/g, ' ').slice(0, 80) });
      if (out.length >= max) break;
    }
  }
  return out;
}

const claimRe = U => new RegExp(`${esc(U)}(?:又|还|就|也|先|只)?(?:说|问|答应|讲)(?:过|了)?[:：，]?([^。；！？\\n]{4,80})`, 'g');

/** 没加引号的转述：和 AI 某句原话重合 ≥0.8、和用户说过的都 <0.6。 */
export function aiOnlyClaims(note, previous, rows, { labels, max = 8 } = {}) {
  const L = resolveLabels(labels);
  const prev = norm(previous || '');
  const normed = rows.map(r => [r.role, norm(r.text), r.text]);
  const out = [], seen = new Set();
  for (const m of String(note).matchAll(claimRe(L.user))) {
    for (const seg of m[1].replace(/[“”]/g, '').split(/[，,]/)) {
      const q = norm(seg);
      if (q.length < 5 || seen.has(q) || prev.includes(q)) continue;
      seen.add(q);
      const g = grams(q);
      let ai = null, aiBest = 0, userBest = 0;
      for (const [role, t, raw] of normed) {
        if (t.length < 4) continue;
        const c = cover(g, t);
        if (role === 'user') { if (c > userBest) userBest = c; }
        else if (c > aiBest) { aiBest = c; ai = raw; }
      }
      if (aiBest >= 0.8 && userBest < 0.6) {
        out.push({ quote: seg.trim(), text: String(ai).replace(/\s+/g, ' ').slice(0, 80) });
        if (out.length >= max) return out;
      }
    }
  }
  return out;
}

/** 写入前检查：新版本笔记里新出现的、只有 AI 说过的原话和转述。 */
export function speakerFlags(note, previous, rows, opts = {}) {
  return [...aiOnlyQuotes(note, previous, rows), ...aiOnlyClaims(note, previous, rows, opts)];
}

/** 让模型对着清单重写一次时，附在系统提示后面的话。 */
export function speakerFixNote(flags, { labels } = {}) {
  const L = resolveLabels(labels), U = L.user;
  return '【写完后的核对】你刚写的笔记里，下面这些话，在聊天记录里只有你自己说过，' + U + '一次都没说过：\n' +
    flags.map(f => `- “${f.quote}”（你的原话：${f.text}）`).join('\n') +
    `\n如果笔记把它写成了“${U}说”、${U}的想法、${U}的喜好或${U}答应的事，改成“我说”“我想”，或者删掉；` +
    `如果它是视频标题、图片上的字，写清楚是标题或图上的字，别算到${U}头上。其余内容照旧，重新输出整份笔记。`;
}

/**
 * 校对时用：一句笔记里有没有“只有 AI 说过、却没写成‘我’说”的原话或转述。
 * 引号前 10 个字里有“我”就算归给了 AI 自己（除非紧挨着“他说”）。返回有问题的原话数组。
 */
export function speakerProblem(sentence, rows, { labels } = {}) {
  const L = resolveLabels(labels), U = esc(L.user), S = esc(L.self);
  const text = String(sentence), out = [];
  for (const m of text.matchAll(/“([^”]{2,80})”/g)) {
    const q = norm(m[1]); if (q.length < 3) continue;
    const hits = rows.filter(r => norm(r.text).includes(q));
    if (!hits.length || hits.some(isUser)) continue;
    const before = text.slice(Math.max(0, m.index - 10), m.index);
    if (!new RegExp(S).test(before) || new RegExp(`${U}(?:说|问|答应|讲)`).test(before)) out.push(m[1]);
  }
  for (const f of aiOnlyClaims(text, '', rows, { labels })) out.push(f.quote);
  return out;
}
