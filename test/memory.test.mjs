// CompanionMemory 整条流程，用假模型跑，不调 API。
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { CompanionMemory } from '../src/index.mjs';
import { BUGGY, tmpDir, clock, fakeLLM, loadInto } from './helpers.mjs';

const NOTE_OK = BUGGY.replace('他走再远也说“这趟值了”。', '').replace(/他养了一只柯基。/, '');
const NOTE_BAD = NOTE_OK.replace('说话短，常回“好哦”。', '说话短，常回“好哦”。他走再远也说“这趟值了”。');
const STYLE = '# 我和他说话的习惯\n\n## 他接得住的\n\n他发视频时我先说感受。\n\n## 他不买账的\n\n太长的说教。\n\n## 我想改改的\n\n少用同一个表情。';

function route(system, user) {
  if (system.includes('个人记忆整理器')) {
    const { messages } = JSON.parse(user);
    const m = messages.find(x => x.text.includes('通勤')) || messages[0];
    return JSON.stringify({ facts: [{ key: 'k' + m.messageId, kind: m.text.includes('论文') ? 'ongoing' : 'profile', evidence: m.text.slice(0, Math.max(4, Math.min(12, m.text.length))), messageId: m.messageId }] });
  }
  if (system.includes('请更新这份笔记')) return system.includes('写完后的核对') ? NOTE_OK : NOTE_BAD;
  if (system.includes('回头看看你自己是怎么回话的')) return STYLE;
  if (system.includes('写一份这一周的回顾')) { const t = system.match(/第一行是“(# [^”]+)”/)[1]; return t + '\n\n这周他答辩过了，那个老师没为难他。\n\n周六他打羽毛球。'; }
  if (system.includes('写一份这个月的回顾')) { const t = system.match(/第一行是“(# [^”]+)”/)[1]; return t + '\n\n这个月他答辩过了。'; }
  if (system.includes('笔记校对助手')) {
    const claim = user.match(/【笔记这句】(.*)/)[1];
    if (claim.includes('这趟值了')) return '{"verdict":"说话人搞反","problem":"“这趟值了”是她说的，他只回了好哦","evidence":[43],"fix":"他走了两万步，我说“这趟值了”。"}';
    if (claim.includes('火锅')) return '{"verdict":"有出入","problem":"是她说火锅我请、日子你定，谁请谁定弄反了","evidence":[66,67],"fix":"火锅我请，日子他定（11-02）。"}';
    if (claim.includes('柯基')) return '{"verdict":"找不到依据","problem":"聊天里没有提过柯基","evidence":[],"fix":""}';
    return '{"verdict":"有据","problem":"","evidence":[1],"fix":""}';
  }
  return new Error('没想到的调用：' + system.slice(0, 40));
}

function setup(t, start = '2026-11-16T12:00:00Z') {
  const dir = tmpDir(t), c = clock(start), llm = fakeLLM(route);
  const mem = new CompanionMemory({ dir, llm, persona: { name: '小满' }, now: c.now });
  loadInto(mem);
  return { dir, c, llm, mem };
}

test('空闲时：摘事实 → 整理笔记（说话人重写）→ 说话习惯 → 回顾', async t => {
  const { dir, mem, llm } = setup(t);
  const ran = await mem.idle();
  assert.deepEqual(ran.map(r => r.job).slice(0, 4), ['facts', 'note', 'style', 'reviews']);
  assert.ok(mem.facts().length >= 1, '摘到事实');
  assert.ok(!mem.note().includes('这趟值了'), '用的是重写后的版本');
  const ev = mem.events().map(e => e.kind);
  assert.ok(ev.includes('note_speaker_retry'));
  assert.ok(llm.calls.some(c => c.system.includes('写完后的核对')));
  assert.ok(llm.calls.find(c => c.system.includes('请更新这份笔记')).user.includes('"who":"他"'), '记录标的是他/我');
  assert.ok(fs.existsSync(path.join(dir, 'style.md')));
  assert.ok(fs.readdirSync(path.join(dir, 'reviews')).length === 1);
});

test('对账：自动改说话人类、其余成疑点、写报告和统计；下次整理带上疑点', async t => {
  const { dir, mem, llm, c } = setup(t);
  fs.writeFileSync(path.join(dir, 'note.md'), BUGGY);
  const r = await mem.runAudit();
  assert.equal(r.done, true); assert.equal(r.fixed, 1); assert.equal(r.flagged, 2);
  assert.match(mem.note(), /我说“这趟值了”/);
  assert.ok(fs.existsSync(path.join(dir, 'note-history.jsonl')), '旧版留在历史里');
  const doubts = JSON.parse(fs.readFileSync(path.join(dir, 'doubts.json'), 'utf8'));
  assert.equal(doubts.items.length, 2);
  assert.ok(doubts.items.find(d => d.text.includes('火锅')).source.some(s => s.who === '我' && s.text.includes('火锅我请')), '疑点附了原文，AI 的话标“我”');
  const report = fs.readFileSync(r.report, 'utf8');
  assert.match(report, /已自动改正/); assert.match(report, /## 错误类型统计/);
  const stats = fs.readFileSync(path.join(dir, 'error-stats.jsonl'), 'utf8').trim().split('\n').map(JSON.parse);
  assert.equal(stats[0].byKind['AI的话算成用户的'], 1); assert.equal(stats[0].byKind['谁对谁弄反'], 1); assert.equal(stats[0].byKind['找不到依据'], 1);

  // 下一次整理：疑点附进输入，写完标 consumed
  c.add(3600e3);
  await mem.updateNote({ force: true });
  const call = llm.calls.filter(x => x.system.includes('请更新这份笔记')).at(-1);
  assert.match(call.system, /上次对账的疑点/);
  assert.equal(JSON.parse(call.user).doubts.length, 2);
  const after = JSON.parse(fs.readFileSync(path.join(dir, 'doubts.json'), 'utf8'));
  assert.equal(after.consumed, true);

  // 同一周再跑：已完成，不重复
  assert.equal(await mem.auditStep(), null);
});

test('对账分几次空闲做完；聊天没停 30 分钟不动', async t => {
  const { dir, mem, c } = setup(t, '2026-11-14T11:40:00Z'); // 最后一句是 11:32Z，才过 8 分钟
  fs.writeFileSync(path.join(dir, 'note.md'), BUGGY);
  assert.equal(await mem.auditStep(), null);
  c.add(30 * 60e3);
  const r1 = await mem.auditStep();
  assert.ok(r1.left > 0);
  let r; do { r = await mem.auditStep(); } while (r && !r.done);
  assert.equal(r.done, true);
});

test('笔记写断了：不写入、记原因、30 分钟内不重试', async t => {
  const dir = tmpDir(t), c = clock('2026-11-16T12:00:00Z');
  const llm = fakeLLM(s => s.includes('请更新这份笔记') ? '# 我对他的了解\n\n## 他是怎样的人\n\n他每天' : new Error('x'));
  const mem = new CompanionMemory({ dir, llm, now: c.now, features: { facts: false, style: false, reviews: false, audit: false, health: false } });
  loadInto(mem);
  await mem.idle();
  assert.equal(mem.note(), '');
  assert.equal(mem.events().find(e => e.kind === 'note_rejected').reason, 'missing_section');
  const n = llm.calls.length;
  await mem.updateNote({ force: true });
  assert.equal(llm.calls.length, n, '冷却中');
});

test('上下文：带现在几点、笔记、相关回顾和原话', async t => {
  const { mem } = setup(t);
  await mem.idle();
  const ctx = mem.context('答辩那天那个老师为难你没');
  assert.match(ctx, /现在是 11-16 周一 20:00/);
  assert.match(ctx, /# 我对他的了解/);
  assert.match(ctx, /说话的习惯/);
  assert.match(ctx, /原话记录/);
});

test('体检：有聊天但笔记很久没更新会提醒', async t => {
  const dir = tmpDir(t), c = clock('2026-11-16T12:00:00Z');
  const mem = new CompanionMemory({ dir, llm: fakeLLM(() => new Error('不该调')), now: c.now });
  for (let i = 0; i < 40; i++) mem.log(i % 2 ? 'assistant' : 'user', '第' + i + '句话', { at: c.t - (40 - i) * 60e3 });
  const r = mem.healthCheck({ force: true });
  assert.equal(r.ok, false);
  assert.ok(r.alerts.some(a => a.includes('了解笔记')));
  assert.equal(mem.healthCheck(), null, '7 天内不重复');
});
