import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createMemoryServer, injectMemory } from '../src/server.mjs';
import { tmpDir } from './helpers.mjs';

// 假的上游：记下收到的请求，按 stream 返回流式或普通回复
function fakeUpstream() {
  const seen = [];
  const s = http.createServer(async (req, res) => {
    const chunks = []; for await (const c of req) chunks.push(c);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : null;
    seen.push({ url: req.url, auth: req.headers.authorization, body });
    if (req.method === 'GET') { res.writeHead(200, { 'Content-Type': 'application/json' }); return res.end('{"data":[{"id":"m"}]}'); }
    if (body.stream) {
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      for (const t of ['走这么远，', '这趟值了！']) res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: t } }] })}\n\n`);
      return res.end('data: [DONE]\n\n');
    }
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ choices: [{ message: { role: 'assistant', content: '<think>想想</think>好呀' } }] }));
  });
  return new Promise(r => s.listen(0, '127.0.0.1', () => r({ s, seen, url: `http://127.0.0.1:${s.address().port}/v1` })));
}
const listen = srv => new Promise(r => srv.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${srv.address().port}`)));
const post = (url, body, headers = {}) => fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer sk-test', ...headers }, body: JSON.stringify(body) });

test('injectMemory 只动最后一条用户消息，历史不变', () => {
  const msgs = [{ role: 'system', content: '人设' }, { role: 'user', content: '早' }, { role: 'assistant', content: '早呀' }, { role: 'user', content: [{ type: 'text', text: '看图' }, { type: 'image_url', image_url: { url: 'x' } }] }];
  const a = injectMemory(msgs, '记忆块');
  assert.deepEqual(a.slice(0, 3), msgs.slice(0, 3));
  assert.match(a[3].content[0].text, /<memory>\n记忆块/); assert.equal(a[3].content.length, 3);
  const b = injectMemory(msgs, '记忆块', { inject: 'system' });
  assert.equal(b.length, 5); assert.deepEqual(b[3], { role: 'system', content: '记忆块' });
});

test('代理：记两边的话、拼记忆、流式原样转发、重新生成不重复记', async t => {
  const up = await fakeUpstream();
  const dir = tmpDir(t);
  const srv = createMemoryServer({ upstream: up.url, dataDir: dir, llm: async () => '', idleMinutes: 0, logger: () => {} });
  const base = await listen(srv);
  try {
    const r1 = await post(base + '/v1/chat/completions', { model: 'm', messages: [{ role: 'system', content: '人设' }, { role: 'user', content: '今天走了两万步' }] });
    assert.equal((await r1.json()).choices[0].message.content, '<think>想想</think>好呀');
    const sent = up.seen[0];
    assert.equal(sent.url, '/v1/chat/completions'); assert.equal(sent.auth, 'Bearer sk-test');
    assert.equal(sent.body.messages[0].content, '人设');
    assert.match(sent.body.messages[1].content, /^<memory>\n【记忆资料[\s\S]*<\/memory>\n\n今天走了两万步$/);

    const turn2 = [{ role: 'system', content: '人设' }, { role: 'user', content: '今天走了两万步' }, { role: 'assistant', content: '好呀' }, { role: 'user', content: '好哦' }];
    const r2 = await post(base + '/chat/completions', { model: 'm', stream: true, messages: turn2 });
    const text = await r2.text();
    assert.match(text, /这趟值了/); assert.match(text, /\[DONE\]/);
    assert.equal(up.seen[1].body.messages[2].content, '好呀'); // 历史原样
    const rows = () => srv.memories.get('default').rows();
    assert.deepEqual(rows().map(r => [r.role, r.text]), [['user', '今天走了两万步'], ['assistant', '好呀'], ['user', '好哦'], ['assistant', '走这么远，这趟值了！']]);

    // 重新生成：同样的历史再发一遍，用户那句不再记，新回复标 regen
    await (await post(base + '/v1/chat/completions', { model: 'm', messages: turn2 })).text();
    assert.equal(rows().filter(r => r.role === 'user').length, 2);
    assert.equal(rows().at(-1).regen, true);
    // 用户真的又说了一遍“好哦”：历史变长，照常记
    await (await post(base + '/v1/chat/completions', { model: 'm', messages: [...turn2, { role: 'assistant', content: '好呀' }, { role: 'user', content: '好哦' }] })).text();
    assert.equal(rows().filter(r => r.role === 'user').length, 3);

    // 工具调用：同一轮的后续请求（最后一条是 tool）不再记用户那句
    const n = rows().length;
    await (await post(base + '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: '查下天气' }] })).text();
    await (await post(base + '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: '查下天气' }, { role: 'assistant', content: null, tool_calls: [{ id: 't1', type: 'function', function: { name: 'weather', arguments: '{}' } }] }, { role: 'tool', tool_call_id: 't1', content: '晴' }] })).text();
    assert.deepEqual(rows().slice(n).map(r => r.role), ['user', 'assistant', 'assistant']);
    assert.equal(rows().slice(n).filter(r => r.text === '查下天气').length, 1);

    // X-Memory: off 原样转发、不记
    await (await post(base + '/v1/chat/completions', { model: 'm', messages: [{ role: 'user', content: '帮我起个标题' }] }, { 'X-Memory': 'off' })).text();
    assert.equal(up.seen.at(-1).body.messages[0].content, '帮我起个标题');
    assert.ok(!srv.memories.get('default').rows().some(r => r.text === '帮我起个标题'));

    // 其他接口透传
    assert.equal((await (await fetch(base + '/v1/models')).json()).data[0].id, 'm');
    assert.equal(up.seen.at(-1).url, '/v1/models');
  } finally { srv.close(); up.s.close(); }
});

test('HTTP 接口：按 user 分开记，context 能取到记忆块', async t => {
  const up = await fakeUpstream();
  const srv = createMemoryServer({ upstream: up.url, dataDir: tmpDir(t), llm: async () => '', idleMinutes: 0, logger: () => {} });
  const base = await listen(srv);
  try {
    assert.equal((await post(base + '/memory/log', { role: 'user', text: '我不吃香菜', user: 'alice' })).status, 200);
    assert.equal((await post(base + '/memory/log', { role: 'bot', text: 'x' })).status, 400);
    const ctx = await (await post(base + '/memory/context', { query: '香菜', user: 'alice' })).json();
    assert.match(ctx.context, /现在是/);
    const st = await (await fetch(base + '/memory/status?user=alice')).json();
    assert.equal(st.rows, 1);
    assert.equal((await (await fetch(base + '/memory/status')).json()).rows, 0);
    assert.match(await (await fetch(base + '/memory/note')).text(), /还没有笔记/);
  } finally { srv.close(); up.s.close(); }
});
