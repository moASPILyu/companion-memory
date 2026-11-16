#!/usr/bin/env node
// companion-memory 命令行。
//   node bin/companion-memory.mjs            第一次会问几个问题生成配置，然后启动记忆代理
//   node bin/companion-memory.mjs init       重新生成配置
//   node bin/companion-memory.mjs note       看笔记
//   node bin/companion-memory.mjs audit      马上对账一次（会调模型）
//   --config <文件>                           配置文件，默认 ./companion-memory.json
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { createMemoryServer } from '../src/server.mjs';
import { CompanionMemory } from '../src/memory.mjs';
import { openaiLLM } from '../adapters/openai.mjs';

const args = process.argv.slice(2);
const ci = args.indexOf('--config');
const CONFIG = path.resolve(ci >= 0 ? args[ci + 1] : 'companion-memory.json');
const cmd = args.filter((a, i) => !a.startsWith('--') && (ci < 0 || i !== ci + 1))[0] || 'start';
const ENV = path.join(path.dirname(CONFIG), '.env');

// 本目录的 .env（只在本机，已在 .gitignore 里）：MEMORY_LLM_KEY=…；已经设了环境变量的以环境变量为准
function loadEnv() {
  if (!fs.existsSync(ENV)) return;
  for (const line of fs.readFileSync(ENV, 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^(['"])(.*)\1$/, '$2');
  }
}
function saveKey(key) {
  const keep = fs.existsSync(ENV) ? fs.readFileSync(ENV, 'utf8').split(/\r?\n/).filter(l => l && !/^\s*MEMORY_LLM_KEY\s*=/.test(l)) : [];
  fs.writeFileSync(ENV, [...keep, `MEMORY_LLM_KEY=${key}`].join('\n') + '\n', { encoding: 'utf8', mode: 0o600 });
}

const PRESETS = {
  1: { name: 'DeepSeek', upstream: 'https://api.deepseek.com', model: 'deepseek-flash' },
  2: { name: 'OpenAI', upstream: 'https://api.openai.com/v1' },
  3: { name: '硅基流动', upstream: 'https://api.siliconflow.cn/v1' },
  4: { name: '本地 Ollama', upstream: 'http://127.0.0.1:11434/v1' },
};

async function init() {
  // 自己排队读行：手打和管道输入都行；输入结束后一律用默认值
  const rl = readline.createInterface({ input: process.stdin }), lines = [], waiters = []; let ended = false;
  rl.on('line', l => waiters.length ? waiters.shift()(l) : lines.push(l));
  rl.on('close', () => { ended = true; while (waiters.length) waiters.shift()(''); });
  const next = () => lines.length ? Promise.resolve(lines.shift()) : ended ? Promise.resolve('') : new Promise(r => waiters.push(r));
  const ask = async (q, d = '', secret = false) => { process.stdout.write(d ? `${q}（直接回车＝${d}）：` : `${q}：`); const a = (await next()).trim(); if (!process.stdin.isTTY) process.stdout.write((secret ? (a ? '（已输入）' : '') : (a || d)) + '\n'); return a || d; };
  console.log('\n== companion-memory 初始化 ==\n回答几个问题，生成 ' + CONFIG + '。\n');
  console.log('你的机器人原来用的是哪家的模型接口？');
  for (const [k, p] of Object.entries(PRESETS)) console.log(`  ${k}. ${p.name}  ${p.upstream}`);
  console.log('  5. 其他（自己填地址）');
  const pick = await ask('选一个', '1');
  const pre = PRESETS[pick] || {};
  const upstream = pre.upstream || await ask('接口地址（以 /v1 结尾或官方给的 base_url）');
  let model = await ask('整理记忆用哪个模型（便宜的就行，每天调几次到几十次；不确定就填机器人现在用的模型名）', pre.model || '');
  while (!model && !ended) model = await ask('模型名不能空');
  if (!model) throw new Error('没填模型名');
  const name = await ask('AI 叫什么名字', '小满');
  const about = await ask('她/他和用户是什么关系', '你在聊天软件里一直陪着的那个人');
  const traits = await ask('性格关键词（反省说话习惯时不许改掉的）', '嘴硬、爱斗嘴');
  const user = await ask('笔记里怎么称呼用户（他/她/TA）', '他');
  let ai = await ask('笔记里怎么称呼 AI 自己的第三人称（她/他/TA，要和上一个不同）', user === '她' ? 'TA' : '她');
  if (ai === user) { ai = user === 'TA' ? '她' : 'TA'; console.log(`两个称呼一样会分不清谁说的，AI 改用“${ai}”。`); }
  const port = Number(await ask('代理端口', '8787')) || 8787;
  console.log('\n整理记忆要调模型，需要一把 key。');
  console.log('  · 只用“改 API 地址”的代理方式：直接回车，会借用机器人请求里带的 key（只放内存）。');
  console.log('  · 用 AstrBot 插件或 HTTP 接口：机器人不经过代理，借不到 key，这里要填。');
  const key = await ask('整理记忆用的 key（存进本目录 .env，只在本机）', '', true);
  rl.close(); process.stdin.pause();
  if (key) { saveKey(key); process.env.MEMORY_LLM_KEY = key; console.log('key 已存到 ' + ENV); }
  const cfg = { port, host: '127.0.0.1', upstream, dataDir: './memory-data', organizer: { model }, persona: { name, about, traits }, labels: { user, self: '我', ai }, offset: 8, inject: 'user', idleMinutes: 5 };
  fs.writeFileSync(CONFIG, JSON.stringify(cfg, null, 2) + '\n', 'utf8');
  console.log('\n已写入 ' + CONFIG + '，以后想改直接改这个文件。\n');
  return cfg;
}

function loadConfig() { return JSON.parse(fs.readFileSync(CONFIG, 'utf8')); }
function dataDirOf(cfg) { return path.resolve(path.dirname(CONFIG), cfg.dataDir || './memory-data'); }

async function start() {
  const cfg = fs.existsSync(CONFIG) ? loadConfig() : await init();
  const server = createMemoryServer({ ...cfg, dataDir: dataDirOf(cfg) });
  const host = cfg.host || '127.0.0.1', port = cfg.port || 8787;
  server.on('error', e => { console.error(e.code === 'EADDRINUSE' ? `端口 ${port} 被占用了，改一下 ${CONFIG} 里的 port。` : e.message); process.exit(1); });
  server.listen(port, host, () => {
    const base = `http://${host === '0.0.0.0' ? '127.0.0.1' : host}:${port}/v1`;
    console.log(`\n记忆代理已启动 → 转发到 ${cfg.upstream}`);
    console.log(`\n把机器人里的 API 地址（base_url）改成：\n\n    ${base}\n\nkey 和模型名照旧。数据在 ${dataDirOf(cfg)}`);
    console.log(process.env.MEMORY_LLM_KEY ? '整理记忆用 MEMORY_LLM_KEY（环境变量或 .env）。' : '没设 MEMORY_LLM_KEY：整理记忆会借用机器人请求里带的 key（只放内存）。用插件或 HTTP 接口时要在 .env 里设。');
    console.log(`AstrBot 插件 / HTTP 接口用的地址：${base.replace(/\/v1$/, '')}`);
    if (host !== '127.0.0.1' && host !== 'localhost') console.log('\n注意：监听的不是本机地址，这个服务没有密码，别暴露到公网。');
    console.log('\n看笔记：浏览器打开 ' + base.replace(/\/v1$/, '/memory/note') + '    停止：Ctrl+C\n');
  });
}

async function offline(fn) {
  const cfg = loadConfig();
  const key = process.env.MEMORY_LLM_KEY;
  const llm = key ? openaiLLM({ baseUrl: cfg.organizer?.baseUrl || cfg.upstream, model: cfg.organizer?.model || 'deepseek-flash', apiKey: key }) : async () => { throw new Error('请先在 .env 或环境变量里设置 MEMORY_LLM_KEY'); };
  const mem = new CompanionMemory({ dir: path.join(dataDirOf(cfg), args.includes('--user') ? args[args.indexOf('--user') + 1] : 'default'), llm, persona: cfg.persona, labels: cfg.labels, offset: cfg.offset ?? 8 });
  await fn(mem);
}

const HELP = `用法：node bin/companion-memory.mjs [start|init|note|audit] [--config 文件] [--user 名字]`;
try {
  loadEnv();
  if (cmd === 'start') await start();
  else if (cmd === 'init') await init();
  else if (cmd === 'note') await offline(async m => console.log(m.note() || '（还没有笔记）'));
  else if (cmd === 'audit') await offline(async m => { const r = await m.runAudit(); console.log(r ? `自动改 ${r.fixed} 句，疑点 ${r.flagged} 句，报告：${r.report}` : '没有可对账的笔记'); });
  else console.log(HELP);
} catch (e) { console.error(e.message || e); process.exit(1); }
