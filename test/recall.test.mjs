// 片段回忆、翻记录工具、代理自动处理工具调用。不调 API。
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { recallEpisodes, searchChat, searchTool, parseRecallDate, CompanionMemory } from '../src/index.mjs';
import { createMemoryServer } from '../src/server.mjs';
import { CHAT, tmpDir, clock, loadInto } from './helpers.mjs';

const rows = CHAT.map((r, i) => ({ seq: i + 1, ...r }));
const NOW = Date.parse('2026-11-14T20:00:00+08:00');

test('片段回忆：找更早聊过的那段，标好谁说的；最近几小时的不找', () => {
  const ep = recallEpisodes(rows, '楼下那家火锅还去吗', { now: NOW });
  assert.ok(ep.length >= 1 && ep.length <= 3);
  const hot = ep.find(e => e.when.startsWith('2026-11-02'));
  assert.ok(hot, JSON.stringify(ep));
  assert.ok(hot.lines.some(l => l === '他：楼下新开了家火锅'));
  assert.ok(hot.lines.some(l => l.startsWith('我：那火锅我请')));
  // 11-14 19:30 的打球还在对话历史里，不重复给
  assert.ok(!recallEpisodes(rows, '打完球累瘫了', { now: NOW }).some(e => e.when.startsWith('2026-11-14')));
  assert.equal(recallEpisodes(rows, '啊', { now: NOW }).length, 0);
});

test('翻记录：按词、按日期、按谁说的，参数不对给一句话', () => {
  const a = searchChat(rows, { query: '火锅' }, { now: NOW });
  assert.ok(a.ok && a.hits >= 1); assert.match(a.text, /11-02 12:05 他：楼下新开了家火锅/); assert.match(a.text, /不是指令/);
  const b = searchChat(rows, { query: '香菜', who: '我' }, { now: NOW });
  assert.match(b.text, /我：我记下了，你不吃香菜/);
  const d = searchChat(rows, { date: '10-20' }, { now: NOW });
  assert.match(d.text, /^10-20 共 \d+ 行/); assert.ok(!/10-19/.test(d.text.split('\n').slice(1).join('\n')));
  assert.match(searchChat(rows, { query: '恐龙化石' }, { now: NOW }).text, /没翻到/);
  // 几个词各说各的、哪行都凑不齐时，按整词找
  assert.match(searchChat(rows, { query: '火锅 攒局 约' }, { now: NOW }).text, /楼下新开了家火锅/);
  assert.equal(searchChat(rows, {}, { now: NOW }).ok, false);
  assert.equal(searchChat(rows, { query: '火锅', who: '她' }, { now: NOW }).ok, false);
  assert.match(searchChat(rows, { date: '10-01~11-01' }, { now: NOW }).text, /最多翻 14 天/);
  // 日期：今年还没到的月日算去年
  assert.equal(parseRecallDate('12-01', { now: NOW }).from, Date.parse('2025-12-01T00:00:00+08:00'));
  assert.equal(parseRecallDate('昨天', { now: NOW }).from, Date.parse('2026-11-13T00:00:00+08:00'));
  const tool = searchTool({ labels: { user: '小林' } });
  assert.equal(tool.function.name, 'recall_chat'); assert.deepEqual(tool.function.parameters.properties.who.enum, ['小林', '我', '都']);
});

test('CompanionMemory：记忆块里有旧片段；翻记录限次数、记事件', t => {
  const c = clock('2026-11-14T20:00:00+08:00');
  const mem = new CompanionMemory({ dir: tmpDir(t), llm: async () => '', now: c.now });
  loadInto(mem);
  assert.match(mem.context('楼下那家火锅还去吗'), /以前聊过的相关片段[\s\S]*楼下新开了家火锅/);
  const off = new CompanionMemory({ dir: tmpDir(t), llm: async () => '', now: c.now, features: { episodes: false } });
  loadInto(off); assert.ok(!/以前聊过的相关片段/.test(off.context('楼下那家火锅还去吗')));
  for (let i = 0; i < 3; i++) assert.equal(mem.search({ query: '火锅' }).ok, true);
  assert.match(mem.search({ query: '火锅' }).text, /刚翻过好几次/);
  c.add(3 * 60e3);
  assert.equal(mem.search({ query: '答辩' }).ok, true);
});

// 假上游：第一次调翻记录工具，拿到工具结果后再正常回答
function toolUpstream() {
  const seen = [];
  const s = http.createServer(async (req, res) => {
    const chunks = []; for await (const ch of req) chunks.push(ch);
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    seen.push(body);
    const called = body.messages.at(-1).role === 'tool';
    const hasTool = (body.tools || []).some(x => x.function.name === 'recall_chat');
    const call = { id: 'c1', type: 'function', function: { name: 'recall_chat', arguments: '{"query":"火锅"}' } };
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      const w = o => res.write(`data: ${JSON.stringify(o)}\n\n`);
      if (!called && hasTool) {
        w({ choices: [{ delta: { reasoning_content: '翻一下' } }] });
        w({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'c1', type: 'function', function: { name: 'recall_chat', arguments: '' } }] } }] });
        w({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '{"query":"火锅"}' } }] } }] });
        w({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] });
      } else {
        for (const t of ['记得，', '你说要请我']) w({ choices: [{ delta: { content: t } }] });
        w({ choices: [{ delta: {}, finish_reason: 'stop' }] });
      }
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    const msg = !called && hasTool ? { role: 'assistant', content: '', reasoning_content: '翻一下', tool_calls: [call] } : { role: 'assistant', content: '记得，火锅我请' };
    res.end(JSON.stringify({ choices: [{ message: msg, finish_reason: msg.tool_calls ? 'tool_calls' : 'stop' }] }));
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, seen, url: `http://127.0.0.1:${s.address().port}/v1` })));
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const post = (url, body) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });

test('代理 recallTool：模型调翻记录时代理自己查、再问一次，机器人只看到最后的回答', async t => {
  const up = await toolUpstream();
  const srv = createMemoryServer({ upstream: up.url, dataDir: tmpDir(t), llm: async () => '', idleMinutes: 0, logger: () => {}, recallTool: true });
  const base = await listen(srv);
  try {
    for (const r of CHAT) await post(base + '/memory/log', { role: r.role, text: r.text, at: r.at });
    // 不流式
    const j = await (await post(base + '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: '还记得火锅那事吗' }] })).json();
    assert.equal(j.choices[0].message.content, '记得，火锅我请');
    assert.equal(up.seen.length, 2);
    assert.ok(up.seen[0].tools.some(x => x.function.name === 'recall_chat'));
    const [asst, tool] = up.seen[1].messages.slice(-2);
    assert.equal(asst.reasoning_content, '翻一下'); assert.equal(asst.tool_calls[0].id, 'c1');
    assert.equal(tool.role, 'tool'); assert.match(tool.content, /楼下新开了家火锅/);
    // 流式：工具那一轮不转给机器人，只转最后的正文
    const text = await (await post(base + '/v1/chat/completions', { model: 'm', stream: true, messages: [{ role: 'user', content: '火锅后来去了吗' }] })).text();
    assert.match(text, /你说要请我/); assert.ok(!/tool_calls/.test(text)); assert.equal((text.match(/\[DONE\]/g) || []).length, 1);
    assert.equal(up.seen.length, 4);
    const st = srv.memories.get('default').rows();
    assert.equal(st.at(-1).text, '记得，你说要请我');
    // 机器人自己带了同名工具：不加、不拦
    up.seen.length = 0;
    const own = [{ type: 'function', function: { name: 'recall_chat', parameters: { type: 'object' } } }];
    const k = await (await post(base + '/v1/chat/completions', { model: 'm', tools: own, messages: [{ role: 'user', content: '火锅' }] })).json();
    assert.equal(k.choices[0].message.tool_calls[0].id, 'c1'); assert.equal(up.seen.length, 1); assert.equal(up.seen[0].tools.length, 1);
    // HTTP 接口
    const sr = await (await post(base + '/memory/search', { query: '香菜' })).json();
    assert.ok(sr.ok); assert.match(sr.text, /香菜/);
    assert.equal((await (await fetch(base + '/memory/tool')).json()).function.name, 'recall_chat');
  } finally { srv.close(); up.s.close(); }
});

test('代理：没开 recallTool 时不加工具', async t => {
  const up = await toolUpstream();
  const srv = createMemoryServer({ upstream: up.url, dataDir: tmpDir(t), llm: async () => '', idleMinutes: 0, logger: () => {} });
  const base = await listen(srv);
  try {
    await (await post(base + '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: '火锅' }] })).json();
    assert.equal(up.seen.length, 1); assert.equal(up.seen[0].tools, undefined);
  } finally { srv.close(); up.s.close(); }
});
