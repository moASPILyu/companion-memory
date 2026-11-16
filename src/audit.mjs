// 回原文对账：把笔记逐句拿去和流水账比。
//
// 模型判错大约七成准（我们在真实数据上人工核过），所以：
//   - 只有“说话人搞反”、且机械检查也认（这句里有只有 AI 说过的原话，改后的写法把它归回“我”）才自动改；
//   - 其他判错（有出入、过时、张冠李戴、找不到依据）不改笔记，写进报告，并作为“疑点”连同原文
//     交给下一次整理笔记，让 AI 自己对着原文判断改不改；
//   - 判“有据”的句子记下，以后跳过，只查新写或改过的句子。
import { norm, grams, localMinute, resolveLabels, esc } from './text.mjs';
import { speakerProblem } from './speaker.mjs';

export const claimKey = s => norm(s);

/** 拆句：按小节，再按句号/分号拆；太短的并到前一句。skip 里的小节（AI 自己的疑问）不查。 */
export function splitClaims(note, { skip = ['我还想知道的'] } = {}) {
  const claims = []; let sec = '';
  for (const line of String(note).split('\n')) {
    if (/^##\s/.test(line)) { sec = line.replace(/^##\s*/, '').trim(); continue; }
    if (!line.trim() || /^#\s/.test(line) || skip.includes(sec)) continue;
    for (const p of line.replace(/^\s*[-*]\s+/, '').split(/(?<=[。；])/).map(s => s.trim()).filter(Boolean)) {
      // 只把很短的碎片（“（我猜）”这类）并到前一句；“每周六打羽毛球。”这种完整短句单独查
      if (claims.length && claims.at(-1).sec === sec && norm(p).length < 6) claims.at(-1).text += p;
      else claims.push({ sec, text: p });
    }
  }
  return claims.map((c, n) => ({ n, ...c }));
}

/**
 * 证据库。rows：流水账 [{seq, role, text, at}]。
 * extras：别的记录 [{id, who, at, text, kind}]，kind 'fact' 算事实（比如送礼记录），'hint' 只当旁证（比如 AI 自己写的日记）。
 */
export function evidenceBase(rows, extras = [], { labels, offset = 8 } = {}) {
  const L = resolveLabels(labels);
  const lines = rows.map(r => ({ src: 'chat', seq: r.seq, who: r.role === 'user' ? L.user : L.ai, at: localMinute(r.at, offset), text: String(r.text || '') }));
  for (const x of extras) if (x?.text) lines.push({ src: x.kind === 'hint' ? 'hint' : 'fact', seq: x.id ?? '', who: x.who || '', at: typeof x.at === 'string' && !/T/.test(x.at) ? x.at : localMinute(x.at, offset), text: String(x.text) });
  const df = new Map(), rg = lines.map(l => { const g = grams(l.text); for (const x of g) df.set(x, (df.get(x) || 0) + 1); return g; });
  const N = lines.length, idf = x => Math.log((N + 1) / ((df.get(x) || 0) + 1));
  const chatIdx = lines.map((l, i) => l.src === 'chat' ? i : -1).filter(i => i >= 0);
  const pos = new Map(chatIdx.map((i, k) => [i, k]));
  const fmt = l => `[#${l.seq} ${l.at} ${l.who}] ${l.text.replace(/\s+/g, ' ').slice(0, 220)}`;
  return {
    lines,
    /** 引号原话精确命中优先，再按二字组 IDF 排；聊天行带前后 2 行，旁证最多 3 条，总共不超过 cap 行。 */
    forClaim(text, cap = 100) {
      const first = [];
      for (const m of String(text).matchAll(/“([^”]{2,80})”/g)) {
        const q = norm(m[1]); if (q.length < 2) continue;
        const hit = []; lines.forEach((l, i) => { if (l.src === 'chat' && norm(l.text).includes(q)) hit.push(i); });
        first.push(...(hit.length > 4 ? [...hit.slice(0, 2), ...hit.slice(-2)] : hit));
      }
      // 笔记句子带了日期（11-05），就把那天的聊天也放进来：转述和原话用词对不上时（“少熬夜”和“少熬点夜”）靠它兜底
      for (const m of String(text).matchAll(/[（(](\d{1,2})-(\d{1,2})[）)]/g)) {
        const day = m[1].padStart(2, '0') + '-' + m[2].padStart(2, '0');
        first.push(...chatIdx.filter(i => lines[i].at.slice(5, 10) === day).slice(0, 12));
      }
      // 太常见的字组不拿来找；聊天少的时候门槛放宽，否则“答辩”这种主题词也会被当成常见词滤掉
      const qg = [...grams(text)].filter(x => (df.get(x) || 0) < Math.max(12, N * 0.05));
      const scored = [];
      // 中两个字组以上才算；只中一个但很少见（比如“火锅”）也算，否则只有一个关键词的句子找不到原文
      rg.forEach((g, i) => { let s = 0, h = 0; for (const x of qg) if (g.has(x)) { s += idf(x); h++; } if (h >= 2 || s >= 4.5) scored.push([s, i]); });
      scored.sort((a, b) => b[0] - a[0]);
      // 判“过时”要看这件事最近一次被提起：最少见的 3 个字组，各取最后 2 次出现的聊天行
      const latest = [];
      for (const x of qg.filter(x => df.get(x)).sort((a, b) => df.get(a) - df.get(b)).slice(0, 3)) {
        const hit = chatIdx.filter(i => rg[i].has(x)); latest.push(...hit.slice(-2));
      }
      const ranked = [...new Set([...first, ...scored.slice(0, 30).map(x => x[1]), ...latest])];
      const keep = new Set(); let hints = 0;
      for (const i of ranked) {
        const win = [];
        if (lines[i].src === 'chat') { const k = pos.get(i); for (let j = k - 2; j <= k + 2; j++) if (j >= 0 && j < chatIdx.length && !keep.has(chatIdx[j])) win.push(chatIdx[j]); }
        else if (lines[i].src === 'hint') { if (hints >= 3) continue; hints++; win.push(i); }
        else win.push(i);
        if (keep.size + win.length > cap) break;
        win.forEach(j => keep.add(j));
      }
      const pick = src => [...keep].filter(i => lines[i].src === src).sort((a, b) => a - b).map(i => fmt(lines[i]));
      return { chat: pick('chat'), fact: pick('fact'), hint: pick('hint'), count: keep.size };
    },
  };
}

export const VERDICTS = ['有据', '说话人搞反', '有出入', '过时', '张冠李戴', '找不到依据', '证据不足'];

export function checkPrompt(claim, ev, today, { labels, persona = {}, title } = {}) {
  const L = resolveLabels(labels), U = L.user, A = L.ai;
  const name = persona.name || '这个 AI 角色';
  const book = (title || `我对${U}的了解`).replace(/^#\s*/, '');
  return `你在帮一个陪伴型 AI 角色“${name}”校对她写的笔记《${book}》。笔记里“我”=${name}，“${U}”=她陪着的那个用户。
下面给你笔记里的一句话，以及检索出的相关记录。每行 [#序号 本地时间 说话人] 内容；“${U}”=用户说的，“${A}”=${name}说的。
聊天记录是主要的事实来源；“其他事实记录”也算事实；“旁证”是${name}自己事后写的，转述可能有错，不能单独证明“${U}说过/${U}做过”。检索可能不全。

今天是 ${today}（本地时间）。

请判断这句笔记。笔记本来就是${name}用自己的话概括，用词不同、合理归纳（比如从${U}问的专业问题推断${U}懂这行）都算没问题。只抓下面这些实打实的错：
1. 说话人搞反：笔记说“${U}说/${U}喜欢/${U}答应/${U}想”的那句话或那个意思，在聊天里其实是“${A}”先说出来的（${U}只回了“好哦”“hhh”之类，或根本没接），或者反过来。判这个必须能指出那句原话的序号和说话人。
2. 有出入：具体事实对不上（数字、对象、谁送谁、谁定、谁请、结果、先后）。
3. 过时：更晚的记录表明情况已经变了，笔记还写成现在进行。
4. 张冠李戴：说的是视频/二创/别人里的角色或情节，笔记却写成${U}本人的事。
5. 找不到依据：记录里该出现却完全没有。检索可能不全，拿不准就判“证据不足”，不要判错。

拿不准时宁可判“有据”或“证据不足”，不要硬找错。只输出一个 JSON 对象，不要别的文字：
{"verdict":"${VERDICTS.join('|')}","problem":"一句话说明哪里不对（有据则留空）","evidence":[相关序号],"fix":"按记录改正后的写法（有据则留空），保持原笔记口吻，短"}

【笔记所在小节】${claim.sec}
【笔记这句】${claim.text}

【聊天记录片段】
${ev.chat.join('\n') || '（无）'}${ev.fact.length ? '\n\n【其他事实记录】\n' + ev.fact.join('\n') : ''}${ev.hint.length ? '\n\n【旁证（只当参考）】\n' + ev.hint.join('\n') : ''}`;
}

export function parseVerdict(content) {
  try {
    const m = String(content).match(/\{[\s\S]*\}/);
    if (!m) return { verdict: '解析失败', problem: '没有输出' };
    // 模型常把证据写成 [#2264, D-3] 这种不带引号的样子，先补上引号再解析
    const fixed = m[0].replace(/("evidence"\s*:\s*\[)([^\]]*)\]/, (_, a, b) => a + b.split(',').map(x => x.trim().replace(/^["']|["']$/g, '').replace(/^#/, '')).filter(Boolean).map(x => JSON.stringify(x)).join(',') + ']');
    const j = JSON.parse(fixed);
    if (!VERDICTS.includes(j.verdict)) return { verdict: '解析失败', problem: String(j.verdict).slice(0, 40) };
    return { verdict: j.verdict, problem: String(j.problem || '').slice(0, 200), evidence: Array.isArray(j.evidence) ? j.evidence.slice(0, 12) : [], fix: String(j.fix || '').trim().slice(0, 300) };
  } catch { return { verdict: '解析失败', problem: String(content).slice(0, 80) }; }
}

/**
 * 自动改的门槛。返回 'ok'（没问题）、'auto'（可以自动改）、'report'（只报告）、'skip'（没判出来）。
 * auto 要同时满足：判“说话人搞反”且给了改法；原句机械检查有问题；改后的句子机械检查没问题；长度没乱；
 * 改法没有新添“他说/他答应/他想……”（真实数据里出现过：本来该改成“我提议的”，被改成“他答应……”，正好又反了）。
 */
export function gate(claim, v, rows, { labels } = {}) {
  if (v.verdict === '有据' || v.verdict === '证据不足') return 'ok';
  if (v.verdict === '解析失败') return 'skip';
  if (v.verdict !== '说话人搞反' || !v.fix || v.fix === claim.text) return 'report';
  if (!speakerProblem(claim.text, rows, { labels }).length) return 'report';
  if (speakerProblem(v.fix, rows, { labels }).length) return 'report';
  if (v.fix.length > claim.text.length * 1.6 + 10 || v.fix.length < claim.text.length * 0.3) return 'report';
  const U = esc(resolveLabels(labels).user);
  const userVerbs = s => (String(s).match(new RegExp(`${U}(?:又|还|就|也|先|只|都)?(?:说|问|答应|讲|想|要|喜欢|觉得|提议|定)`, 'g')) || []).length;
  if (userVerbs(v.fix) > userVerbs(claim.text)) return 'report';
  return 'auto';
}

/** 把自动改的句子换进笔记（每句只换一次，原句找不到就跳过）。 */
export function applyFixes(note, autos) {
  let out = String(note); const done = [];
  for (const a of autos) { if (!out.includes(a.text)) continue; out = out.replace(a.text, a.fix); done.push(a); }
  return { note: out, done };
}

export function reportMd({ week, today, results, applied, title = '笔记' }) {
  const bad = results.filter(r => r.gate === 'report');
  const lines = [`# 《${title.replace(/^#\s*/, '')}》对账报告 ${week}`, '', `核对时间：${today}。查了 ${results.length} 句（以前核过、没改过的句子跳过）。`,
    `自动改正 ${applied.length} 句（只改说话人搞反、机械检查也确认的）；另有 ${bad.length} 句模型觉得有问题、没自动改，列在下面，会作为疑点交给下一次整理。模型判错不全准，下面的不一定都是错。`, ''];
  if (applied.length) { lines.push('## 已自动改正', ''); for (const a of applied) lines.push(`- 原：${a.text}`, `  改：${a.fix}`, `  依据：${a.problem}（${(a.evidence || []).map(x => '#' + x).join(' ')}）`); lines.push(''); }
  if (bad.length) { lines.push('## 疑点（没改）', ''); for (const r of bad) lines.push(`- 【${r.verdict}】${r.text}`, `  问题：${r.problem}`, r.fix ? `  建议：${r.fix}` : '', `  证据：${(r.evidence || []).map(x => '#' + x).join(' ')}`); }
  return lines.filter(x => x !== '').join('\n') + '\n';
}

/** 疑点：没自动改的判错，附上聊天原文（证据前后各 1 行，最多 8 行），最多 max 条。who 用“他/我”，和整理笔记时一致。 */
// 疑点超过上限时先留哪几类：说话人、张冠李戴最伤人，排前面。没进疑点的不算“查过”，下次对账还会再查。
const DOUBT_ORDER = ['说话人搞反', '张冠李戴', '有出入', '找不到依据', '过时'];
const doubtRank = v => { const i = DOUBT_ORDER.indexOf(v); return i < 0 ? DOUBT_ORDER.length : i; };

export function buildDoubts(flagged, rows, { labels, offset = 8, max = 12 } = {}) {
  const L = resolveLabels(labels);
  const bySeq = new Map(rows.map((r, i) => [String(r.seq), i]));
  const line = r => ({ who: r.role === 'user' ? L.user : L.self, at: localMinute(r.at, offset).slice(5), text: String(r.text).replace(/\s+/g, ' ').slice(0, 140) });
  const picked = flagged.map((r, i) => [r, i]).sort((a, b) => doubtRank(a[0].verdict) - doubtRank(b[0].verdict) || a[1] - b[1]).slice(0, max).sort((a, b) => a[1] - b[1]).map(x => x[0]);
  return picked.map(r => {
    const keep = new Set();
    for (const e of r.evidence || []) { const i = bySeq.get(String(e).replace(/^#/, '')); if (i === undefined) continue; for (let j = i - 1; j <= i + 1; j++) if (j >= 0 && j < rows.length) keep.add(j); }
    return { text: r.text, problem: r.problem, suggest: r.fix || '', source: [...keep].sort((a, b) => a - b).slice(0, 8).map(i => line(rows[i])) };
  });
}

export const doubtRule = ({ labels } = {}) => {
  const L = resolveLabels(labels), U = L.user;
  return `【上次对账的疑点】输入里的 doubts 是后台把你的笔记逐句对照聊天原文后，觉得可能写错的几句，每条附了原文（who：“${U}”是${U}说的，“我”是你说的）和一个改法建议。逐条对着原文看：确实写错了（谁说的弄反了、事实对不上、已经过时），就在笔记里改过来，改法不必照抄建议；原文看不出错、或者拿不准，就照旧留着。别的内容照常更新，不要因为这些疑点删掉不相关的句子。`;
};

/** 整理写完后：哪些疑点句子还原样留着（AI 看过、觉得没错），记下来以后不再提。 */
export function doubtsAfter(doubts, note) {
  const kept = doubts.items.filter(d => String(note).includes(d.text)).map(d => claimKey(d.text));
  return { ...doubts, consumed: true, kept, changed: doubts.items.length - kept.length };
}

/**
 * 一次性对完整份笔记（离线、脚本用）。llm(system, user) 返回模型文字。
 * 返回 {note, results, applied}；不写文件。
 */
export async function auditNote({ note, rows, extras = [], llm, today, labels, persona, title, offset = 8, checked = new Set(), concurrency = 4, maxClaims = 120, onResult }) {
  const base = evidenceBase(rows, extras, { labels, offset });
  const todo = splitClaims(note).filter(c => !checked.has(claimKey(c.text))).slice(0, maxClaims);
  const results = []; let k = 0;
  async function worker() {
    while (k < todo.length) {
      const c = todo[k++];
      const ev = base.forClaim(c.text);
      let v;
      for (let t = 0; t < 2; t++) {
        try { v = parseVerdict(await llm(SYS, checkPrompt(c, ev, today, { labels, persona, title }))); } catch (e) { v = { verdict: '解析失败', problem: String(e?.message || e).slice(0, 80) }; }
        if (v.verdict !== '解析失败') break;
      }
      const r = { ...c, ...v, evCount: ev.count, gate: gate(c, v, rows, { labels }) };
      results.push(r); onResult?.(r);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, worker));
  results.sort((a, b) => a.n - b.n);
  const { note: fixed, done } = applyFixes(note, results.filter(r => r.gate === 'auto'));
  return { note: fixed, results, applied: done };
}

export const SYS = '你是笔记校对助手。只输出一个 JSON 对象。';
