import test from 'node:test';
import assert from 'node:assert/strict';
import { Ledger } from '../src/ledger.mjs';
import { speakerFlags, speakerProblem } from '../src/speaker.mjs';
import { acceptFacts, activeFacts } from '../src/facts.mjs';
import { validateNote, recordsFrom, notePrompt } from '../src/note.mjs';
import { splitClaims, gate, parseVerdict, evidenceBase, applyFixes, doubtsAfter, buildDoubts } from '../src/audit.mjs';
import { errorKind, trendMd } from '../src/stats.mjs';
import { dueReview, recallReviews, isoWeek } from '../src/reviews.mjs';
import { stamp, weekKey } from '../src/text.mjs';
import { CHAT, BUGGY, tmpDir } from './helpers.mjs';

const rows = CHAT.map((r, i) => ({ seq: i + 1, ...r }));

test('流水账：按月分卷、seq 递增、重开接着编号', t => {
  const dir = tmpDir(t);
  const a = new Ledger({ dir });
  a.append({ role: 'user', text: '十月', at: '2026-10-31T15:00:00Z' }); // 北京时间 10-31 23:00，算十月
  a.append({ role: 'assistant', text: '十一月', at: '2026-11-02T01:00:00Z' });
  const b = new Ledger({ dir });
  const r = b.append({ role: 'user', text: '再来一句', at: '2026-11-03T01:00:00Z' });
  assert.equal(r.seq, 3);
  assert.deepEqual(b.volumes().map(p => p.slice(-13)), ['2026-10.jsonl', '2026-11.jsonl']);
  assert.throws(() => b.append({ role: 'system', text: 'x' }));
});

test('时间：北京时间戳和周编号', () => {
  assert.equal(stamp('2026-11-16T12:07:00Z'), '11-16 周一 20:07');
  assert.equal(weekKey(Date.parse('2026-11-16T12:00:00Z')), '2026-W47');
  assert.equal(isoWeek(Date.parse('2026-11-15T16:30:00Z')).key, '2026-W47'); // 北京时间周一 0:30
});

test('写入前检查：AI 自己说的“这趟值了”被写成他的', () => {
  const flags = speakerFlags('他走再远也说“这趟值了”。', '', rows);
  assert.deepEqual(flags.map(f => f.quote), ['这趟值了']);
  assert.equal(speakerFlags('他说“香菜是邪物”。', '', rows).length, 0, '他自己说过的不算');
  assert.equal(speakerFlags('他走再远也说“这趟值了”。', '他走再远也说“这趟值了”。', rows).length, 0, '旧笔记里已有的不重复提');
});

test('写入前检查：没加引号的转述', () => {
  const flags = speakerFlags('他说少熬点夜眼睛都要熬坏了。', '', rows);
  assert.equal(flags.length, 1);
});

test('speakerProblem：写成“我说”就不算错', () => {
  assert.deepEqual(speakerProblem('他走再远也说“这趟值了”。', rows), ['这趟值了']);
  assert.deepEqual(speakerProblem('他走了两万步，我说“这趟值了”。', rows), []);
});

test('原话事实：evidence 必须逐字在那条消息里', () => {
  const msgs = rows.filter(r => r.role === 'user').slice(0, 10);
  const pick = msgs.find(m => m.text.includes('通勤'));
  const raw = JSON.stringify({ facts: [
    { key: '通勤', kind: 'profile', evidence: '每天通勤一小时', messageId: String(pick.seq), note: '地铁通勤' },
    { key: '编的', kind: 'profile', evidence: '他养了一只柯基', messageId: String(pick.seq) },
    { key: '密钥', kind: 'profile', evidence: '每天通勤一小时', messageId: String(pick.seq) },
  ] });
  const { facts, rejected } = acceptFacts(raw, msgs);
  assert.equal(facts.length, 1); assert.equal(rejected, 2);
  assert.throws(() => acceptFacts('不是 JSON', msgs));
});

test('原话事实：ongoing 30 天后不算、同 key 后来的覆盖', () => {
  const now = Date.parse('2026-12-31T00:00:00Z');
  const all = [
    { id: '1', key: '论文', kind: 'ongoing', evidence: '在赶论文', observedAt: '2026-10-29T05:00:00Z' },
    { id: '2', key: '饮料', kind: 'preference', evidence: '冰美式', observedAt: '2026-10-23T00:00:00Z' },
    { id: '3', key: '饮料', kind: 'preference', evidence: '改喝热拿铁了', observedAt: '2026-12-01T00:00:00Z' },
  ];
  assert.deepEqual(activeFacts(all, now).map(f => f.evidence), ['改喝热拿铁了']);
});

test('笔记格式检查', () => {
  const title = '# 我对他的了解', sections = ['## A', '## B'];
  const ok = '# 我对他的了解\n\n## A\n\n一句。\n\n## B\n\n两句。';
  assert.equal(validateNote(ok, { title, sections }), null);
  assert.equal(validateNote(ok.replace('## B', '## C'), { title, sections }), 'missing_section');
  assert.equal(validateNote(ok.slice(0, -1), { title, sections }), 'cut_off');
  assert.equal(validateNote(ok, { title, sections, previous: ok + '很长'.repeat(50) }), 'shrunk');
  assert.equal(validateNote(ok.replace('一句。', '密码：123。'), { title, sections }), 'credential');
});

test('整理笔记：记录标“他/我”和本地时间，提示里带现在几点', () => {
  const { records, lastSeq } = recordsFrom(rows, 0);
  assert.equal(records[0].who, '他'); assert.equal(records[1].who, '我');
  assert.equal(records[0].at, '10-19 周一 21:02');
  assert.equal(lastSeq, rows.length);
  const [sys, input] = notePrompt({ persona: { name: '小满' }, records, now: '11-16 周一 20:07' });
  assert.match(sys, /你是小满/); assert.match(sys, /【时间】/);
  assert.equal(JSON.parse(input).now, '11-16 周一 20:07');
});

test('拆句：“我还想知道的”不查，短句并到前一句', () => {
  const claims = splitClaims(BUGGY);
  assert.ok(claims.some(c => c.text.includes('柯基')));
  assert.ok(!claims.some(c => c.text.includes('实验数据补好')));
  assert.ok(claims.every(c => c.sec));
});

test('证据检索：找得到原话所在的那几行', () => {
  const ev = evidenceBase(rows).forClaim('火锅他请，日子我定（11-02）。');
  assert.ok(ev.chat.some(l => l.includes('火锅我请，日子你定')));
  assert.ok(ev.chat.some(l => /\] 行，那下周六吧/.test(l) || l.includes('下周六')));
});

test('自动改门槛：只放行说话人类、机械检查也认的', () => {
  const c = { text: '他走再远也说“这趟值了”。' };
  assert.equal(gate(c, { verdict: '说话人搞反', fix: '他走了两万步，我说“这趟值了”。' }, rows), 'auto');
  assert.equal(gate(c, { verdict: '说话人搞反', fix: '他走再远都说“这趟值了”！' }, rows), 'report', '改完还是他说的');
  assert.equal(gate({ text: '火锅他请，日子我定。' }, { verdict: '有出入', fix: '火锅我请，日子他定。' }, rows), 'report', '不是说话人类');
  assert.equal(gate({ text: '他提议去看海。' }, { verdict: '说话人搞反', fix: '我提议去看海，他答应了。' }, rows), 'report', '原句没有机械可查的原话');
  assert.equal(gate(c, { verdict: '有据' }, rows), 'ok');
});

test('解析：证据编号不带引号也能读', () => {
  const v = parseVerdict('想了想。{"verdict":"有出入","problem":"x","evidence":[#12, D-3],"fix":"y"}');
  assert.equal(v.verdict, '有出入'); assert.deepEqual(v.evidence, ['12', 'D-3']);
  assert.equal(parseVerdict('{"verdict":"随便"}').verdict, '解析失败');
});

test('疑点：AI 留着没改的句子记成 kept', () => {
  const d = { items: [{ text: '甲。' }, { text: '乙。' }] };
  const after = doubtsAfter(d, '甲。丙。');
  assert.equal(after.changed, 1); assert.equal(after.kept.length, 1); assert.equal(after.consumed, true);
  assert.equal(applyFixes('甲。乙。', [{ text: '乙。', fix: '丁。' }, { text: '没有。', fix: 'x' }]).done.length, 1);
});

test('错误分类和走势表', () => {
  assert.equal(errorKind({ verdict: '说话人搞反', problem: '“这趟值了”是她在#43说的，他只回了好哦', text: '他走再远也说“这趟值了”。' }), 'AI的话算成用户的');
  assert.equal(errorKind({ verdict: '有出入', problem: '是她说火锅我请、日子你定，谁请谁定弄反了', text: '火锅他请，日子我定。' }), '谁对谁弄反');
  assert.equal(errorKind({ verdict: '张冠李戴', problem: '那是视频标题', text: '' }), '视频剧情当成真事');
  assert.equal(errorKind({ verdict: '过时', problem: '已经答辩过了', text: '' }), '过时');
  const md = trendMd([{ week: 'W1', flagged: 2, checked: 10, byKind: { 过时: 1, '谁对谁弄反': 1 } }, { week: 'W2', flagged: 3, checked: 5, byKind: { '谁对谁弄反': 3 } }]);
  assert.match(md, /反复出现：「谁对谁弄反」/);
});

test('回顾：结束了的周先写，月等周都写完', () => {
  const has = new Set();
  const now = Date.parse('2026-11-16T12:00:00Z');
  const due = dueReview(rows, { now, has: k => has.has(k), minRows: 10 });
  assert.equal(due.kind, 'week'); assert.equal(due.key, '2026-W43');
  const filler = ['他每天地铁通勤。', '周五他分享了猫视频。', '他周六打羽毛球输了。', '食堂又放香菜。', '他喝了冰美式。', '晚霞像橘子汽水。'];
  const paras = recallReviews([{ text: '# 第44周\n\n周三他答辩过了，那个老师没为难他。\n\n' + filler.join('\n\n') }], '答辩那天老师有没有为难你');
  assert.equal(paras.length, 1); assert.match(paras[0], /答辩过了/);
});

test('疑点超上限时先留说话人类，顺序仍按笔记', () => {
  const flagged = [
    { text: 'a', verdict: '过时' }, { text: 'b', verdict: '有出入' }, { text: 'c', verdict: '说话人搞反' },
    { text: 'd', verdict: '找不到依据' }, { text: 'e', verdict: '说话人搞反' },
  ];
  const items = buildDoubts(flagged, [], { max: 3 });
  assert.deepEqual(items.map(i => i.text), ['b', 'c', 'e']);
  assert.equal(buildDoubts(flagged, []).length, 5);
});
