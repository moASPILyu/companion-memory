// 最小示例：把合成聊天记进流水账，跑一遍整理，看笔记和要拼进提示词的记忆块，再跑一轮对账。
// 用法：MEMORY_LLM_KEY=你的key node examples/demo.mjs
// 默认用 DeepSeek；换别家：MEMORY_LLM_BASE=https://api.openai.com/v1 MEMORY_LLM_MODEL=gpt-4.1-mini
// 数据写在 examples/out/demo/，可以打开看每个文件。
import path from 'node:path';
import { CompanionMemory } from '../src/index.mjs';
import { openaiLLM } from '../adapters/openai.mjs';
import { loadChat } from './load-chat.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const llm = openaiLLM({ baseUrl: process.env.MEMORY_LLM_BASE || 'https://api.deepseek.com', model: process.env.MEMORY_LLM_MODEL || 'deepseek-flash', tokenCap: 400000 });

// 示例聊天停在 11-14，把“现在”定在 11-16 晚上，好看出日期规则（火锅约在 11-14，过了没听说办没办）
const now = () => Date.parse('2026-11-16T12:00:00Z');
const mem = new CompanionMemory({
  dir: path.join(HERE, 'out', 'demo'), llm, now,
  persona: { name: '小满', about: '你在聊天软件里一直陪着的那个人', traits: '嘴硬、爱斗嘴、叫他小呆瓜' },
});

if (!mem.rows().length) for (const r of loadChat(path.join(HERE, 'chat.txt'))) mem.log(r.role, r.text, { at: r.at });

console.log('整理中（摘事实、写笔记、说话习惯、补写回顾）…');
for (let i = 0; i < 12; i++) { const ran = await mem.idle(); if (!ran.length) break; console.log(ran.map(r => r.job).join(' → ')); }

console.log('\n===== 笔记 =====\n' + mem.note());
console.log('\n===== 他问“火锅还去吗”时，拼进提示词的记忆块 =====\n' + mem.context('火锅还去吗'));

console.log('\n对账中（逐句回原文核对）…');
const r = await mem.runAudit();
console.log(r ? `自动改 ${r.fixed} 句，疑点 ${r.flagged} 句，报告：${r.report}` : '没有可对账的笔记');
console.log('\n用量：', llm.usage);
