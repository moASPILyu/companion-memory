// 本地记忆服务：一个 OpenAI 兼容的代理，外加几个普通 HTTP 接口。
//
// 代理（不用改机器人代码）：
//   机器人原来调 https://api.deepseek.com，现在把 API 地址改成 http://127.0.0.1:8787/v1，key 和模型名照旧。
//   每次请求：记下用户最后一句 → 把记忆块拼进这一轮 → 转发给原来的接口 → 回复原样返回，同时记下 AI 的回复。
//   支持流式（stream: true）。空闲时自动整理、对账。
//
// HTTP 接口（任何语言的机器人都能用，见 docs/接入.md）：
//   POST /memory/log      {role:'user'|'assistant', text}
//   POST /memory/context  {query} → {context}
//   POST /memory/idle     → {ran}
//   GET  /memory/note     → 笔记全文
//   GET  /memory/status   → 条数、最近事件
// 都可以带 user（请求体字段，或请求头 X-Memory-User）区分不同的人，每人一个数据目录。
//
// 默认只监听 127.0.0.1，没有鉴权，不要直接暴露到公网。
import http from 'node:http';
import path from 'node:path';
import { CompanionMemory } from './memory.mjs';
import { openaiLLM } from '../adapters/openai.mjs';
import { resolveLabels } from './text.mjs';

const HOP = new Set(['host', 'connection', 'content-length', 'accept-encoding', 'keep-alive', 'transfer-encoding', 'upgrade', 'x-memory', 'x-memory-user']);
const REGEN_MS = 10 * 60e3;

/** 消息内容可能是字符串，也可能是 [{type:'text',text}, {type:'image_url',...}]。 */
export function textOf(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) return content.filter(p => p && p.type === 'text').map(p => p.text).join('\n');
  return '';
}

/** 把记忆块放进这一轮：默认拼在最后一条用户消息前面；inject:'system' 时在它前面插一条 system。历史消息不动，提示缓存照样命中。 */
export function injectMemory(messages, block, { inject = 'user' } = {}) {
  const i = messages.findLastIndex(m => m.role === 'user');
  if (i < 0 || !block) return messages;
  const out = messages.slice();
  if (inject === 'system') { out.splice(i, 0, { role: 'system', content: block }); return out; }
  const m = out[i], wrapped = `<memory>\n${block}\n</memory>\n\n`;
  out[i] = Array.isArray(m.content) ? { ...m, content: [{ type: 'text', text: wrapped }, ...m.content] } : { ...m, content: wrapped + textOf(m.content) };
  return out;
}

const stripThink = s => String(s || '').replace(/<think>[\s\S]*?<\/think>/g, '').trim();
const userId = v => { const s = String(v || '').trim(); return /^[A-Za-z0-9_-][A-Za-z0-9_.-]{0,63}$/.test(s) ? s : 'default'; };

async function readBody(req) { const chunks = []; for await (const c of req) chunks.push(c); return Buffer.concat(chunks); }
function send(res, status, body, type = 'application/json; charset=utf-8') {
  res.writeHead(status, { 'Content-Type': type });
  res.end(typeof body === 'string' ? body : JSON.stringify(body));
}

/**
 * 建服务。cfg：
 *   upstream     机器人原来调的接口，比如 https://api.deepseek.com 或 https://api.openai.com/v1
 *   dataDir      数据目录（每个 user 一个子目录）
 *   persona / labels / offset / features / options：传给 CompanionMemory
 *   organizer    整理记忆用的模型 {baseUrl（默认同 upstream）, model, maxTokens}；key 读环境变量 MEMORY_LLM_KEY（命令行会先读本目录 .env），
 *                没设就借用机器人请求里带的 key（只在内存里，不落盘）
 *   inject       'user'（默认）或 'system'
 *   idleMinutes  每隔几分钟检查一次要不要整理（默认 5）
 *   llm          直接给一个 llm(system, user) 函数（测试用），给了就不用 organizer
 */
export function createMemoryServer(cfg) {
  const upstream = String(cfg.upstream || '').replace(/\/+$/, '');
  if (!upstream) throw new Error('需要 upstream：机器人原来调的 API 地址');
  const labels = resolveLabels(cfg.labels);
  let borrowedKey = '';
  const org = { baseUrl: upstream, model: 'deepseek-flash', maxTokens: 8000, ...(cfg.organizer || {}) };
  let realLLM = null;
  const llm = cfg.llm || (async (system, user) => {
    const key = process.env.MEMORY_LLM_KEY || borrowedKey;
    if (!key) throw new Error('还没有 key：在 .env 或环境变量里设置 MEMORY_LLM_KEY，或者先让机器人通过代理说一句话');
    if (!realLLM || realLLM.key !== key) { realLLM = openaiLLM({ baseUrl: org.baseUrl, model: org.model, apiKey: key, maxTokens: org.maxTokens, extraBody: org.extraBody || {} }); realLLM.key = key; }
    return realLLM(system, user);
  });
  const mems = new Map();
  const memFor = id => {
    if (!mems.has(id)) mems.set(id, new CompanionMemory({ dir: path.join(cfg.dataDir || './memory-data', id), llm, persona: cfg.persona || {}, labels, offset: cfg.offset ?? 8, features: cfg.features, options: cfg.options, now: cfg.now }));
    return mems.get(id);
  };
  const log = cfg.logger || ((...a) => console.log(new Date().toLocaleTimeString(), ...a));

  /**
   * 记用户这一句。“重新生成”会把同样的历史再发一遍：消息条数和最后一句都跟上次一样（10 分钟内），这时不重复记，
   * 新回复标 regen。用户真的又说了一遍同样的话，历史会多出上一轮的回复，条数不同，照常记。
   */
  const lastTurn = new Map();
  function logUser(mem, text, count) {
    const prev = lastTurn.get(mem), now = mem.now();
    lastTurn.set(mem, { text, count, at: now });
    if (prev && prev.text === text && prev.count === count && now - prev.at < REGEN_MS) return false;
    mem.log('user', text); return true;
  }

  async function proxyChat(req, res, raw, rest) {
    let body; try { body = JSON.parse(raw.toString('utf8')); } catch { return forward(req, res, raw, rest); }
    const off = String(req.headers['x-memory'] || '').toLowerCase() === 'off';
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    const lastUser = msgs.findLast(m => m.role === 'user');
    const text = lastUser ? textOf(lastUser.content).trim() : '';
    if (off || !text) return forward(req, res, raw, rest);
    const auth = String(req.headers.authorization || '');
    if (auth.startsWith('Bearer ')) borrowedKey = auth.slice(7);
    const mem = memFor(userId(req.headers['x-memory-user'] || body.user));
    // 工具调用的后续请求（最后一条是 tool / assistant）还是同一轮：用户那句已经记过，不再记，只记最后的文字回复
    const continuing = msgs.at(-1)?.role !== 'user';
    const meta = continuing || logUser(mem, text, msgs.length) ? {} : { regen: true };
    const block = mem.context(text);
    body.messages = injectMemory(msgs, block, { inject: cfg.inject });
    const r = await upstreamFetch(req, JSON.stringify(body), rest);
    const ctype = r.headers.get('content-type') || '';
    if (!r.ok) { res.writeHead(r.status, { 'Content-Type': ctype || 'application/json' }); res.end(Buffer.from(await r.arrayBuffer())); return; }
    if (body.stream || ctype.includes('text/event-stream')) {
      res.writeHead(r.status, { 'Content-Type': ctype || 'text/event-stream', 'Cache-Control': 'no-cache' });
      let buf = '', reply = '';
      const reader = r.body.getReader(), dec = new TextDecoder();
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
        buf += dec.decode(value, { stream: true });
        let k; while ((k = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, k).trim(); buf = buf.slice(k + 1);
          if (!line.startsWith('data:')) continue;
          const d = line.slice(5).trim(); if (d === '[DONE]') continue;
          try { reply += JSON.parse(d).choices?.[0]?.delta?.content || ''; } catch {}
        }
      }
      res.end();
      if (stripThink(reply)) mem.log('assistant', stripThink(reply), meta);
      return;
    }
    const out = Buffer.from(await r.arrayBuffer());
    res.writeHead(r.status, { 'Content-Type': ctype || 'application/json' }); res.end(out);
    try { const reply = stripThink(JSON.parse(out.toString('utf8')).choices?.[0]?.message?.content); if (reply) mem.log('assistant', reply, meta); } catch {}
  }

  function upstreamFetch(req, body, rest) {
    const headers = {};
    for (const [k, v] of Object.entries(req.headers)) if (!HOP.has(k.toLowerCase())) headers[k] = v;
    return fetch(upstream + rest, { method: req.method, headers, body: ['GET', 'HEAD'].includes(req.method) ? undefined : body });
  }
  async function forward(req, res, raw, rest) {
    const r = await upstreamFetch(req, raw, rest);
    const h = {}; r.headers.forEach((v, k) => { if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) h[k] = v; });
    res.writeHead(r.status, h);
    if (r.body) { const reader = r.body.getReader(); for (;;) { const { done, value } = await reader.read(); if (done) break; res.write(value); } }
    res.end();
  }

  async function memoryApi(req, res, raw, route) {
    let body = {}; if (raw.length) { try { body = JSON.parse(raw.toString('utf8')); } catch { return send(res, 400, { error: '请求体不是 JSON' }); } }
    const url = new URL(req.url, 'http://x');
    const mem = memFor(userId(req.headers['x-memory-user'] || body.user || url.searchParams.get('user')));
    if (route === 'log' && req.method === 'POST') {
      if (!['user', 'assistant'].includes(body.role) || !String(body.text || '').trim()) return send(res, 400, { error: '需要 role（user/assistant）和 text' });
      const row = mem.log(body.role, body.role === 'user' ? String(body.text).trim() : stripThink(body.text));
      return send(res, 200, { ok: true, seq: row?.seq });
    }
    if (route === 'context') return send(res, 200, { context: mem.context(String(body.query ?? url.searchParams.get('query') ?? '')) });
    if (route === 'idle' && req.method === 'POST') return send(res, 200, { ran: await mem.idle() });
    if (route === 'note') return send(res, 200, mem.note() || '（还没有笔记：攒够 30 句新聊天、停 10 分钟后会写第一版）', 'text/markdown; charset=utf-8');
    if (route === 'status') return send(res, 200, { rows: mem.rows().length, noteChars: mem.note().length, facts: mem.facts().length, events: mem.events().slice(-10) });
    return send(res, 404, { error: '没有这个接口' });
  }

  const server = http.createServer(async (req, res) => {
    try {
      const raw = await readBody(req);
      const p = new URL(req.url, 'http://x').pathname;
      const m = p.match(/^\/memory\/([a-z]+)\/?$/);
      if (m) return await memoryApi(req, res, raw, m[1]);
      if (p === '/' || p === '/health') return send(res, 200, { ok: true, upstream, hint: '把机器人的 API 地址改成 http://<这里>/v1' });
      const rest = p.replace(/^\/v1(?=\/|$)/, '') + (req.url.includes('?') ? req.url.slice(req.url.indexOf('?')) : '');
      if (req.method === 'POST' && /\/chat\/completions\/?$/.test(p)) return await proxyChat(req, res, raw, rest);
      return await forward(req, res, raw, rest);
    } catch (e) {
      log('出错：', e?.message || e);
      if (!res.headersSent) send(res, 502, { error: { message: 'companion-memory 代理出错：' + (e?.message || e) } }); else res.end();
    }
  });

  let timer = null, running = false;
  async function tick() {
    if (running) return; running = true;
    try { for (const [id, mem] of mems) { const ran = await mem.idle(); if (ran.length) log(`[${id}] 整理：` + ran.map(r => r.job + (r.skipped ? '（跳过）' : '')).join(' → ')); } }
    catch (e) { log('整理出错：', e?.message || e); }
    finally { running = false; }
  }
  server.on('listening', () => { const ms = (cfg.idleMinutes ?? 5) * 60e3; if (ms > 0) timer = setInterval(tick, ms); });
  server.on('close', () => clearInterval(timer));
  server.memories = mems; server.tick = tick;
  return server;
}
