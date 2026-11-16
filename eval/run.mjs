// 用合成数据真调模型，量三件事：
//   1. 对账：note-buggy.md 里埋的 10 处错能抓到几处、对的 8 句误报几句、自动改了几句；
//   2. 疑点交回整理：对账没自动改的疑点附原文交给下一次整理，改对了几处；
//   3. 标签：聊天记录标 user/assistant 和标“他/我”，从零写笔记时把 AI 的话记到用户头上的次数。
//
// 用法：MEMORY_LLM_KEY=... node eval/run.mjs [轮数=2]
// 默认 DeepSeek（OpenAI 兼容接口），可用 MEMORY_LLM_BASE / MEMORY_LLM_MODEL 换。结果写 eval/results.md 和 eval/out/。
import fs from 'node:fs';
import path from 'node:path';
import { openaiLLM } from '../adapters/openai.mjs';
import { CompanionMemory, auditNote, buildDoubts, notePrompt, recordsFrom, speakerFlags, splitClaims } from '../src/index.mjs';
import { loadChat } from '../examples/load-chat.mjs';
import { KEY, BUGS } from '../examples/answer-key.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const OUT = path.join(HERE, 'out'); fs.mkdirSync(OUT, { recursive: true });
const RUNS = Number(process.argv[2] || 2);
const NOW = Date.parse('2026-11-16T12:00:00Z'); // 北京时间 11-16 周一 20:00
const persona = { name: '小满', about: '你在聊天软件里一直陪着的那个人' };
const llm = openaiLLM({
  baseUrl: process.env.MEMORY_LLM_BASE || 'https://api.deepseek.com', model: process.env.MEMORY_LLM_MODEL || 'deepseek-flash',
  maxTokens: 8000, tokenCap: Number(process.env.MEMORY_TOKEN_CAP || 1.5e6),
  extraBody: process.env.MEMORY_LLM_THINKING === '0' ? {} : { thinking: { type: 'enabled' } },
});
const chat = loadChat(path.join(HERE, '..', 'examples', 'chat.txt'));
const rows = chat.map((r, i) => ({ seq: i + 1, ...r }));
const buggy = fs.readFileSync(path.join(HERE, '..', 'examples', 'note-buggy.md'), 'utf8');
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);
const keyOf = text => KEY.find(k => text.includes(k.has));
const stillWrong = note => BUGS.filter(b => b.wrong.test(note)).map(b => b.has);

async function evalAudit(run) {
  const { results, applied, note } = await auditNote({ note: buggy, rows, llm, today: '2026-11-16', persona, concurrency: 4 });
  const per = results.map(r => ({ text: r.text, verdict: r.verdict, gate: r.gate, bug: keyOf(r.text)?.bug || null, problem: r.problem, fix: r.fix }));
  const caught = per.filter(p => p.bug && (p.gate === 'report' || p.gate === 'auto')).length;
  const false_ = per.filter(p => !p.bug && (p.gate === 'report' || p.gate === 'auto')).length;
  fs.writeFileSync(path.join(OUT, `audit-${run}.json`), JSON.stringify(per, null, 1));
  // 疑点交回整理
  const dir = path.join(OUT, `mem-${run}`); fs.mkdirSync(dir, { recursive: true });
  const mem = new CompanionMemory({ dir, llm, persona, now: () => NOW, features: { facts: false, style: false, reviews: false, audit: false, health: false } });
  if (!mem.rows().length) for (const r of chat) mem.log(r.role, r.text, { at: r.at });
  fs.writeFileSync(path.join(dir, 'note.md'), note);
  const items = buildDoubts(results.filter(r => r.gate === 'report' && note.includes(r.text)), mem.rows());
  fs.writeFileSync(path.join(dir, 'doubts.json'), JSON.stringify({ week: '2026-W47', items, consumed: false }));
  fs.writeFileSync(path.join(dir, 'note-state.json'), JSON.stringify({ seq: mem.rows().length })); // 没有新聊天，只看疑点
  await mem.updateNote({ force: true });
  const after = mem.note();
  fs.writeFileSync(path.join(OUT, `note-after-doubts-${run}.md`), after);
  const lost = KEY.filter(k => !k.bug && !after.includes(k.has)).map(k => k.has);
  return { caught, false_, auto: applied.length, doubts: items.length, wrongBefore: stillWrong(buggy).length, wrongAfterAudit: stillWrong(note).length, wrongAfterDoubts: stillWrong(after), lost };
}

// 从零写笔记：两种标签
async function freshNote(mode, run) {
  const { records } = recordsFrom(rows, 0);
  let [system, input] = notePrompt({ persona, records, now: '11-16 周一 20:00' });
  if (mode === 'role') {
    system = system.replace('（每条的 who：“他”是他说的，“我”是你自己说的）', '（每条的 role：user 是他，assistant 是你）').replace('对着 who 写清楚', '对着 role 写清楚');
    input = JSON.stringify({ ...JSON.parse(input), records: records.map(r => ({ role: r.who === '他' ? 'user' : 'assistant', text: r.text, at: r.at })) });
  }
  const note = String(await llm(system, input)).trim();
  fs.writeFileSync(path.join(OUT, `fresh-${mode}-${run}.md`), note);
  const traps = BUGS.filter(b => b.bug !== '找不到依据' && b.bug !== '过时' && b.bug !== '先后细节对不上').filter(b => b.wrong.test(note)).map(b => b.has);
  return { traps, flags: speakerFlags(note, '', rows).map(f => f.quote) };
}

const res = { audit: [], fresh: { role: [], who: [] } };
for (let i = 1; i <= RUNS; i++) {
  log('对账第', i, '轮'); res.audit.push(await evalAudit(i)); log(JSON.stringify(res.audit.at(-1)), JSON.stringify(llm.usage));
  for (const mode of ['role', 'who']) { log('从零写笔记', mode, i); res.fresh[mode].push(await freshNote(mode, i)); log(JSON.stringify(res.fresh[mode].at(-1))); }
}
fs.writeFileSync(path.join(OUT, 'summary.json'), JSON.stringify({ res, usage: llm.usage }, null, 1));

const sum = (a, f) => a.reduce((s, x) => s + f(x), 0);
const claims = splitClaims(buggy).length, nb = BUGS.length;
const md = [`# 合成数据评测`, '', `模型 ${process.env.MEMORY_LLM_MODEL || 'deepseek-flash'}（开思考），${RUNS} 轮。数据是编的：examples/chat.txt（${chat.length} 句）、examples/note-buggy.md（${claims} 句，埋了 ${nb} 处错，见 answer-key.mjs）。`, '',
  '## 1. 对账', '', '| 轮 | 抓到的错 | 误报（对的句子判错） | 自动改 | 交给整理的疑点 |', '|---|---|---|---|---|',
  ...res.audit.map((a, i) => `| ${i + 1} | ${a.caught} / ${nb} | ${a.false_} / ${claims - nb} | ${a.auto} | ${a.doubts} |`), '',
  '## 2. 疑点交回整理后，还错着的', '', '| 轮 | 原来 | 对账自动改后 | 整理改完后 | 还错着的句子 | 被误删的对句子 |', '|---|---|---|---|---|---|',
  ...res.audit.map((a, i) => `| ${i + 1} | ${a.wrongBefore} | ${a.wrongAfterAudit} | ${a.wrongAfterDoubts.length} | ${a.wrongAfterDoubts.join('、') || '无'} | ${a.lost.join('、') || '无'} |`), '',
  '“还错着”按 answer-key.mjs 里的正则判（只认得出常见写法，结果文件在 eval/out/，可以自己看）。', '',
  '## 3. 从零写笔记：标签的影响', '', '说话人、谁对谁、视频当真事这类陷阱 7 处（这趟值了、下雨天、猫的睡姿、小呆瓜、少熬夜、看海、火锅）。', '',
  '| 标签 | 每轮踩中的陷阱 | 写入前检查标出的原话 |', '|---|---|---|',
  ...['role', 'who'].map(m => `| ${m === 'role' ? 'user / assistant' : '他 / 我'} | ${res.fresh[m].map(x => x.traps.length).join('、')}（合计 ${sum(res.fresh[m], x => x.traps.length)}） | ${res.fresh[m].map(x => x.flags.length).join('、')} |`), '',
  `用量：${llm.usage.calls} 次调用，输入 ${llm.usage.prompt} token（缓存命中 ${llm.usage.cached}），输出 ${llm.usage.completion} token。`, ''].join('\n');
fs.writeFileSync(path.join(HERE, 'results.md'), md);
log('完成'); console.log(md);
