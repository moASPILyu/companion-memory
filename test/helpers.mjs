import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadChat } from '../examples/load-chat.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
export const CHAT = loadChat(path.join(HERE, '..', 'examples', 'chat.txt'));
export const BUGGY = fs.readFileSync(path.join(HERE, '..', 'examples', 'note-buggy.md'), 'utf8');

/** 每个测试一个临时目录。设了 MEMORY_TEST_KEEP=1 就留着不删（方便查看）。 */
export function tmpDir(t) {
  const root = process.env.MEMORY_TEST_DIR || os.tmpdir();
  fs.mkdirSync(root, { recursive: true });
  const dir = fs.mkdtempSync(path.join(root, 'cm-test-'));
  if (process.env.MEMORY_TEST_KEEP !== '1') t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** 可控的时钟。 */
export const clock = start => { const c = { t: Date.parse(start) }; c.now = () => c.t; c.add = ms => { c.t += ms; }; return c; };

/** 假模型：按 system/user 里的关键字返回预设输出，记下每次调用。 */
export function fakeLLM(route) {
  const calls = [];
  const llm = async (system, user) => { calls.push({ system, user }); const r = route(system, user, calls.length); if (r instanceof Error) throw r; return r; };
  llm.calls = calls;
  return llm;
}

export function loadInto(mem, rows = CHAT) { for (const r of rows) mem.log(r.role, r.text, { at: r.at }); }
