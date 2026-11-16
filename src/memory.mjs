// 总调度：把流水账、原话事实、两份笔记、回顾、对账、体检串起来。
//
//   const mem = new CompanionMemory({ dir: './data', llm, persona: { name: '小满' } });
//   mem.log('user', '今天走了两万步');          // 每句话都记
//   mem.log('assistant', '走这么远，这趟值了！');
//   const block = mem.context('还记得上次说的火锅吗');  // 拼进这一轮的提示词
//   await mem.idle();                         // 空闲时调用，到点的整理会自己跑
//
// llm(system, user) 返回模型输出的文字。所有整理都在 idle() 里串行跑，同一时间只跑一项。
import path from 'node:path';
import { Ledger, files } from './ledger.mjs';
import { resolveLabels, stamp, localDay, weekKey } from './text.mjs';
import { extractionPrompt, acceptFacts, activeFacts, knownFor, knownForNote, around, sensitive, looksLikeInjection } from './facts.mjs';
import { notePrompt, recordsFrom, validateNote, tidy, defaultSections, defaultTitle } from './note.mjs';
import { speakerFlags, speakerFixNote, speakerProblem } from './speaker.mjs';
import { stylePrompt, styleSections, styleTitle } from './style.mjs';
import { dueReview, weekRecords, weeklyPrompt, monthlyPrompt, rangeText, isoWeek, recallReviews } from './reviews.mjs';
import { splitClaims, evidenceBase, checkPrompt, parseVerdict, gate, applyFixes, reportMd, buildDoubts, doubtRule, doubtsAfter, claimKey, SYS } from './audit.mjs';
import { weekStats, trendMd } from './stats.mjs';
import { buildContext } from './context.mjs';
import { recallEpisodes, searchChat, searchArgsIssue } from './recall.mjs';
import { healthReport } from './health.mjs';

const MIN = 60e3, DAY = 86400e3;

/** 模型偶尔在标题前多说一句，或把标题写成“## 我对他的了解”：标题在就从标题起截，不整份作废。 */
function cutToTitle(raw, title) {
  const t = tidy(raw), name = title.replace(/^#\s*/, '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = t.match(new RegExp('^#{1,3}\\s*' + name, 'm'));
  return m ? (title + t.slice(m.index + m[0].length)).trim() : t;
}

export const DEFAULTS = {
  facts: { minBatch: 6, batchWait: 10 * MIN, batchSize: 12, maxBatches: 3 },
  note: { minNew: 30, fullBatch: 100, quiet: 10 * MIN, maxChars: 2400, maxLen: 3200 },
  style: { minNew: 20, quiet: 30 * MIN, maxChars: 900, maxLen: 1400 },
  reviews: { quiet: 10 * MIN, minRows: 20 },
  audit: { per: 6, quiet: 30 * MIN, maxClaims: 120, maxDoubts: 12 },
  episodes: { max: 3, skipHours: 3 },
  search: { perWindow: 3, windowMs: 2 * MIN, perDay: 30 },
  retryAfter: 30 * MIN,
};

export class CompanionMemory {
  /**
   * dir：数据目录。llm(system, user)：模型调用。persona：{name, about, traits}。
   * labels：{user:'他', self:'我', ai:'她'}。offset：时区小时数。now：取当前时间（测试用）。
   * extras()：可选，返回额外的事实记录 [{id, who, at, text, kind:'fact'|'hint'}]，对账时一起当证据。
   * features：可以关掉某几项，比如 {style:false}。
   */
  constructor({ dir, llm, persona = {}, labels, offset = 8, now = () => Date.now(), extras = () => [], features = {}, options = {} }) {
    this.dir = dir; this.llm = llm; this.persona = persona; this.labels = resolveLabels(labels); this.offset = offset; this.now = now; this.extras = extras;
    this.features = { facts: true, note: true, style: true, reviews: true, episodes: true, audit: true, health: true, ...features };
    this.searches = [];
    this.opt = Object.fromEntries(Object.entries(DEFAULTS).map(([k, v]) => [k, typeof v === 'object' ? { ...v, ...(options[k] || {}) } : (options[k] ?? v)]));
    this.ledger = new Ledger({ dir: path.join(dir, 'ledger'), offset, now });
    this.busy = false; this.failedAt = {};
    this.noteTitle = defaultTitle(this.labels); this.noteSections = defaultSections(this.labels);
    this.styleTitle = styleTitle(this.labels); this.styleSections = styleSections(this.labels);
  }

  // —— 文件 ——
  file(n) { return path.join(this.dir, n); }
  event(kind, data = {}) { files.appendJsonl(this.file('events.jsonl'), { kind, at: new Date(this.now()).toISOString(), ...data }); }
  events() { return files.readJsonl(this.file('events.jsonl')); }
  note() { return files.readText(this.file('note.md')).trim(); }
  style() { return files.readText(this.file('style.md')).trim(); }
  rows() { return this.ledger.rows(); }
  facts() { return activeFacts(files.readJsonl(this.file('facts.jsonl')), this.now()); }

  /** 记一句话。role：'user' 或 'assistant'。 */
  log(role, text, { at, ...meta } = {}) { return this.ledger.append({ role, text, at, ...meta }); }

  /** 这一轮要拼进提示词的记忆块。query 是用户这一轮说的话。 */
  context(query = '') {
    const reviews = this.features.reviews ? recallReviews(this.reviewList(), query) : [];
    const episodes = this.features.episodes ? recallEpisodes(this.rows(), query, { now: this.now(), offset: this.offset, labels: this.labels, ...this.opt.episodes }) : [];
    return buildContext({ now: this.now(), offset: this.offset, query, note: this.note(), style: this.features.style ? this.style() : '', facts: this.features.facts ? this.facts() : [], reviews, episodes, userLabel: this.labels.user });
  }

  /**
   * 翻记录（给 AI 当工具用，工具定义见 searchTool()）。args：{query?, date?, who?}。返回 {ok, hits, text}。
   * 次数有上限（默认 2 分钟 3 次、每天 30 次），防止模型每句都翻。只记参数和命中数，不记结果全文。
   */
  search(args = {}) {
    const issue = searchArgsIssue(args, { labels: this.labels }); if (issue) return { ok: false, hits: 0, text: issue };
    const o = this.opt.search, now = this.now(), day = localDay(now, this.offset);
    this.searches = this.searches.filter(x => x.day === day);
    if (this.searches.length >= o.perDay) return { ok: false, hits: 0, text: '今天翻得够多了，凭印象说吧，拿不准就说记不清。' };
    if (this.searches.filter(x => now - x.at < o.windowMs).length >= o.perWindow) return { ok: false, hits: 0, text: '刚翻过好几次了，先凭现在知道的回答。' };
    this.searches.push({ at: now, day });
    const r = searchChat(this.rows(), args, { now, offset: this.offset, labels: this.labels });
    this.event('chat_search', { query: args.query ?? null, date: args.date ?? null, who: args.who ?? null, hits: r.hits });
    return r;
  }

  // —— 空闲时跑 ——
  /** 按顺序跑到点的整理。返回这次跑了哪些。 */
  async idle() {
    const ran = [];
    for (const [k, fn] of [['facts', 'extractFacts'], ['note', 'updateNote'], ['style', 'updateStyle'], ['reviews', 'updateReviews'], ['audit', 'auditStep'], ['health', 'healthCheck']]) {
      if (!this.features[k]) continue;
      const r = await this[fn](); if (r) ran.push({ job: k, ...r });
    }
    return ran;
  }
  quietFor(rows) { return this.now() - (Date.parse(rows.at(-1)?.at) || 0); }
  cooling(job) { return this.failedAt[job] && this.now() - this.failedAt[job] < this.opt.retryAfter; }
  async guarded(job, fn) {
    if (this.busy || this.cooling(job)) return null;
    this.busy = true;
    try { return await fn(); }
    catch (e) { this.failedAt[job] = this.now(); this.event(job + '_failed', { reason: String(e?.message || e).slice(0, 200) }); return null; }
    finally { this.busy = false; }
  }

  /** 原话事实：攒够一批用户消息（或最早一条等了 10 分钟）再一起看。 */
  extractFacts() {
    return this.guarded('facts', async () => {
      const o = this.opt.facts, st = files.readJson(this.file('facts-state.json'), { seq: 0 });
      const rows = this.rows();
      const queue = rows.filter(r => r.role === 'user' && Number(r.seq) > st.seq && r.text.length >= 4 && r.text.length <= 4000 && !sensitive(r.text) && !looksLikeInjection(r.text));
      let saved = 0, batches = 0, seq = st.seq;
      while (queue.length && batches < o.maxBatches) {
        if (queue.length < o.minBatch && this.now() - Date.parse(queue[0].at) < o.batchWait) break;
        const batch = queue.splice(0, o.batchSize);
        const known = knownFor(this.facts(), batch.map(m => m.text).join('\n'));
        const [system, input] = extractionPrompt(batch, known, around(rows, batch), { userLabel: this.labels.user });
        const { facts, rejected } = acceptFacts(await this.llm(system, input), batch, { now: this.now() });
        const ids = new Set(files.readJsonl(this.file('facts.jsonl')).map(f => f.id));
        for (const f of facts) if (!ids.has(f.id)) { files.appendJsonl(this.file('facts.jsonl'), f); saved++; }
        seq = Number(batch.at(-1).seq); files.writeJson(this.file('facts-state.json'), { seq });
        batches++; this.event('facts_saved', { messages: batch.length, saved: facts.length, ...(rejected ? { rejected } : {}) });
      }
      return batches ? { batches, saved } : null;
    });
  }

  /** 整理《我对他的了解》。force：不等攒够、不等聊天停。 */
  updateNote({ force = false } = {}) {
    return this.guarded('note', async () => {
      const o = this.opt.note, st = files.readJson(this.file('note-state.json'), { seq: 0 });
      const rows = this.rows(), fresh = rows.filter(r => Number(r.seq) > st.seq);
      const doubts = this.pendingDoubts();
      if (!force && !(fresh.length >= o.fullBatch || (fresh.length >= o.minNew && this.quietFor(rows) >= o.quiet))) return null;
      if (!fresh.length && !doubts && !force) return null;
      const { records, lastSeq } = recordsFrom(rows, st.seq, { labels: this.labels, offset: this.offset });
      const previous = this.note();
      let [system, input] = notePrompt({ persona: this.persona, previous, records, known: this.features.facts ? knownForNote(this.facts()) : [], now: stamp(this.now(), this.offset), labels: this.labels, sections: this.noteSections, title: this.noteTitle, maxChars: o.maxChars });
      if (doubts) { system += '\n\n' + doubtRule({ labels: this.labels }); input = JSON.stringify({ ...JSON.parse(input), doubts: doubts.items }); }
      const check = raw => validateNote(raw, { title: this.noteTitle, sections: this.noteSections, maxLen: o.maxLen, previous });
      let raw = cutToTitle(await this.llm(system, input), this.noteTitle);
      const bad = check(raw);
      if (bad) { this.failedAt.note = this.now(); this.event('note_rejected', { reason: bad, chars: raw.length, start: raw.slice(0, 60) }); return null; }
      // 写入前查说话人：新出现的原话只有 AI 说过，就对着清单重写一次；重写不合格用第一版，不硬拒
      const flags = speakerFlags(raw, previous, rows, { labels: this.labels });
      if (flags.length) {
        this.event('note_speaker_retry', { quotes: flags.map(f => f.quote) });
        const raw2 = cutToTitle(await this.llm(system + '\n\n' + speakerFixNote(flags, { labels: this.labels }), input), this.noteTitle);
        const bad2 = check(raw2);
        if (bad2) this.event('note_speaker_retry_bad', { reason: bad2 });
        else { raw = raw2; const left = speakerFlags(raw, previous, rows, { labels: this.labels }); if (left.length) this.event('note_speaker_left', { quotes: left.map(f => f.quote) }); }
      }
      if (previous) files.appendJsonl(this.file('note-history.jsonl'), { replacedAt: new Date(this.now()).toISOString(), text: previous });
      files.writeText(this.file('note.md'), raw + '\n');
      if (doubts) { const d = doubtsAfter(doubts, raw); files.writeJson(this.file('doubts.json'), d); this.event('note_doubts_used', { items: doubts.items.length, changed: d.changed }); }
      files.writeJson(this.file('note-state.json'), { seq: records.length ? lastSeq : st.seq });
      this.event('note_updated', { records: records.length, chars: raw.length });
      return { records: records.length, chars: raw.length };
    });
  }
  pendingDoubts() { const d = files.readJson(this.file('doubts.json')); return d && !d.consumed && d.items?.length ? d : null; }

  /** 说话习惯：每个本地日期最多一次，攒够 20 句、聊天停了 30 分钟。 */
  updateStyle({ force = false } = {}) {
    return this.guarded('style', async () => {
      const o = this.opt.style, st = files.readJson(this.file('style-state.json'), { seq: 0, day: '' });
      const rows = this.rows(), fresh = rows.filter(r => Number(r.seq) > st.seq), today = localDay(this.now(), this.offset);
      if (!force && (fresh.length < o.minNew || st.day === today || this.quietFor(rows) < o.quiet)) return null;
      if (!fresh.length) return null;
      const records = []; let size = 0;
      for (const r of [...fresh].reverse()) {
        const x = { who: r.role === 'user' ? this.labels.user : this.labels.self, text: r.text.slice(0, 300), at: stamp(r.at, this.offset) };
        size += JSON.stringify(x).length; if (records.length && size > 24000) break; records.unshift(x);
      }
      const previous = this.style();
      const raw = cutToTitle(await this.llm(...stylePrompt({ persona: this.persona, previous, records, labels: this.labels, maxChars: o.maxChars })), this.styleTitle);
      const bad = validateNote(raw, { title: this.styleTitle, sections: this.styleSections, maxLen: o.maxLen, previous });
      if (bad) { this.failedAt.style = this.now(); this.event('style_rejected', { reason: bad }); return null; }
      if (previous) files.appendJsonl(this.file('style-history.jsonl'), { replacedAt: new Date(this.now()).toISOString(), text: previous });
      files.writeText(this.file('style.md'), raw + '\n');
      files.writeJson(this.file('style-state.json'), { seq: Number(fresh.at(-1).seq), day: today });
      this.event('style_updated', { records: records.length, chars: raw.length });
      return { records: records.length };
    });
  }

  reviewList() {
    const dir = this.file('reviews'); if (!files.exists(dir)) return [];
    return fsList(dir).filter(n => /^\d{4}-(?:W\d{2}|\d{2})\.md$/.test(n)).sort().map(n => ({ key: n.slice(0, -3), text: files.readText(path.join(dir, n)) }));
  }

  /** 周回顾、月回顾：补写到点了还没写的那一份，写了就不再改。 */
  updateReviews() {
    return this.guarded('reviews', async () => {
      const rows = this.rows(); if (!rows.length || this.quietFor(rows) < this.opt.reviews.quiet) return null;
      const stFile = this.file('reviews-state.json'), st = files.readJson(stFile, { failures: {} });
      const has = k => files.exists(this.file(`reviews/${k}.md`));
      const due = dueReview(rows, { now: this.now(), has, failures: st.failures, offset: this.offset, minRows: this.opt.reviews.minRows });
      if (!due) return null;
      const allFacts = files.readJsonl(this.file('facts.jsonl')).filter(f => { const t = Date.parse(f.observedAt); return t >= due.start && t < due.end; }).map(f => ({ key: f.key, kind: f.kind, evidence: f.evidence, ...(f.note ? { note: f.note } : {}) }));
      let system, input, title, max;
      try {
        if (due.kind === 'week') {
          title = `${due.year}年第${due.week}周的我们`; max = 1300;
          const prev = files.readText(this.file(`reviews/${isoWeek(due.start - DAY, this.offset).key}.md`));
          [system, input] = weeklyPrompt({ persona: this.persona, title, range: rangeText(due, this.offset), records: weekRecords(due.rows, { labels: this.labels, offset: this.offset }), facts: allFacts.slice(-40), previous: prev, labels: this.labels });
        } else {
          const [y, m] = due.key.split('-').map(Number); title = `${y}年${m}月的我们`; max = 1700;
          const weeks = due.weeks.map(k => files.readText(this.file(`reviews/${k}.md`)));
          const hist = files.readJsonl(this.file('note-history.jsonl')).find(h => Date.parse(h.replacedAt) >= due.end)?.text || this.note();
          const pm = new Date(due.start - DAY + this.offset * 3600e3).toISOString().slice(0, 7);
          [system, input] = monthlyPrompt({ persona: this.persona, title, weeks, facts: allFacts, note: hist.slice(0, 3200), previous: files.readText(this.file(`reviews/${pm}.md`)), labels: this.labels });
        }
        const raw = cutToTitle(await this.llm(system, input), '# ' + title);
        const bad = validateNote(raw, { title: '# ' + title, maxLen: max });
        if (bad) throw new Error('rejected:' + bad);
        files.writeText(this.file(`reviews/${due.key}.md`), raw + '\n');
        this.event('review_written', { period: due.key, type: due.kind, chars: raw.length });
        return { period: due.key };
      } catch (e) {
        const f = st.failures[due.key] ?? { count: 0 };
        st.failures[due.key] = { count: f.count + 1, at: this.now() }; files.writeJson(stFile, st);
        throw e;
      }
    });
  }

  /**
   * 对账：每周一轮，聊天停了 30 分钟以上才动，每次最多查 per 句，分几次空闲做完；进度存在 audit-state.json。
   * 全部查完才改笔记、写报告、留疑点、记统计。force：不等聊天停。
   */
  auditStep({ force = false, per } = {}) {
    return this.guarded('audit', async () => {
      const o = this.opt.audit, rows = this.rows(), now = this.now();
      if (!rows.length || (!force && this.quietFor(rows) < o.quiet)) return null;
      const sp = this.file('audit-state.json'), week = weekKey(now, this.offset);
      let st = files.readJson(sp, { week: '', checked: [] });
      if (st.week === week && st.done && !force) return null;
      if (st.week !== week || (st.done && force)) {
        const note = this.note(); if (!note) return null;
        const checked = new Set(st.checked || []);
        // 上次的疑点 AI 对着原文看过、还留着的，算核过，不再反复提
        const d = files.readJson(this.file('doubts.json')); if (d?.consumed) for (const k of d.kept || []) checked.add(k);
        st = { week, startedAt: new Date(now).toISOString(), checked: [...checked], todo: splitClaims(note).filter(c => !checked.has(claimKey(c.text))).slice(0, o.maxClaims), results: [], done: false };
        this.event('audit_started', { week, claims: st.todo.length });
      }
      const base = evidenceBase(rows, this.extras(), { labels: this.labels, offset: this.offset });
      const today = localDay(now, this.offset);
      for (let i = 0; i < (per ?? o.per) && st.todo.length; i++) {
        const c = st.todo.shift(); let v;
        for (let t = 0; t < 2; t++) {
          try { v = parseVerdict(await this.llm(SYS, checkPrompt(c, base.forClaim(c.text), today, { labels: this.labels, persona: this.persona, title: this.noteTitle }))); }
          catch (e) { v = { verdict: '解析失败', problem: String(e?.message || e).slice(0, 80) }; }
          if (v.verdict !== '解析失败') break;
        }
        st.results.push({ ...c, ...v, gate: gate(c, v, rows, { labels: this.labels }) });
        files.writeJson(sp, st);
      }
      if (st.todo.length) { files.writeJson(sp, st); return { week, left: st.todo.length }; }
      return this.finishAudit(st, rows, week, today);
    });
  }
  finishAudit(st, rows, week, today) {
    const now = this.now(), previous = this.note();
    const { note, done } = applyFixes(previous, st.results.filter(r => r.gate === 'auto'));
    let applied = done;
    if (done.length) {
      const bad = validateNote(note.trim(), { title: this.noteTitle, sections: this.noteSections, maxLen: this.opt.note.maxLen, previous });
      if (bad) { this.event('audit_fix_rejected', { week, reason: bad }); applied = []; }
      else { files.appendJsonl(this.file('note-history.jsonl'), { replacedAt: new Date(now).toISOString(), text: previous, by: 'audit' }); files.writeText(this.file('note.md'), note.trim() + '\n'); }
    }
    const finalNote = applied.length ? note : previous;
    // 统计（在疑点文件被覆盖之前读上次的疑点结果）
    let trend = '';
    try {
      const row = weekStats({ week, at: new Date(now).toISOString(), results: st.results, applied, prevDoubts: files.readJson(this.file('doubts.json')), speaker: t => speakerProblem(t, rows, { labels: this.labels }), labels: this.labels, aiName: this.persona.name });
      files.appendJsonl(this.file('error-stats.jsonl'), row);
      trend = trendMd(files.readJsonl(this.file('error-stats.jsonl')));
    } catch (e) { this.event('audit_stats_failed', { reason: String(e?.message || e).slice(0, 120) }); }
    let rp = this.file(`reports/${week}.md`); for (let k = 2; files.exists(rp); k++) rp = this.file(`reports/${week}-${k}.md`);
    files.writeText(rp, reportMd({ week, today, results: st.results, applied, title: this.noteTitle }) + (trend ? '\n' + trend : ''));
    const items = buildDoubts(st.results.filter(r => r.gate === 'report' && finalNote.includes(r.text)), rows, { labels: this.labels, offset: this.offset, max: this.opt.audit.maxDoubts });
    files.writeJson(this.file('doubts.json'), { week, at: new Date(now).toISOString(), items, consumed: false });
    const checked = new Set(st.checked); for (const r of st.results) if (r.gate === 'ok') checked.add(claimKey(r.text));
    for (const a of applied) checked.add(claimKey(a.fix));
    files.writeJson(this.file('audit-state.json'), { week, done: true, finishedAt: new Date(now).toISOString(), checked: [...checked].slice(-400) });
    const flagged = st.results.filter(r => r.gate === 'report').length;
    this.event('audit_done', { week, checked: st.results.length, fixed: applied.length, flagged, report: path.basename(rp) });
    return { week, done: true, fixed: applied.length, flagged, report: rp };
  }
  /** 脚本用：一口气把这一轮对账跑完。 */
  async runAudit({ force = true } = {}) { let r; do { r = await this.auditStep({ force, per: 1000 }); } while (r && !r.done); return r; }

  /** 体检：每 7 天一次，不调模型。 */
  healthCheck({ force = false } = {}) {
    const st = files.readJson(this.file('health-state.json'), { at: 0 });
    if (!force && this.now() - st.at < 7 * DAY) return null;
    files.writeJson(this.file('health-state.json'), { at: this.now() });
    const r = healthReport({ rows: this.rows(), events: this.events(), dir: this.dir, now: this.now(), facts: this.facts().length });
    files.writeText(this.file(`health/${localDay(this.now(), this.offset)}.md`), r.md);
    this.event('health_checked', { ok: r.ok, alerts: r.alerts.length });
    return { ok: r.ok, alerts: r.alerts };
  }
}

import fs from 'node:fs';
const fsList = d => { try { return fs.readdirSync(d); } catch { return []; } };
