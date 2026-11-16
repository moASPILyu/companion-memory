// 流水账：双方说的每句话原样记下，只追加、不改、不删。
// 它是唯一的事实来源：笔记、事实、回顾都是从它整理出来的，整理错了随时能回来对账。
// 按本地月份分卷（ledger/2026-11.jsonl），读过的卷按大小+修改时间缓存，聊得再久也不用每次全读。
import fs from 'node:fs';
import path from 'node:path';

const VOL = /^(\d{4}-\d{2})\.jsonl$/;

export class Ledger {
  /** dir：存放分卷的目录；offset：本地时区小时数（分卷按本地月份）；now：取当前时间（测试用）。 */
  constructor({ dir, offset = 8, now = () => Date.now() }) {
    this.dir = dir; this.offset = offset; this.now = now; this.cache = new Map(); this.lastSeq = null;
    fs.mkdirSync(dir, { recursive: true });
  }
  volumes() { return fs.readdirSync(this.dir).filter(n => VOL.test(n)).sort().map(n => path.join(this.dir, n)); }
  readVolume(p) {
    const st = fs.statSync(p), c = this.cache.get(p);
    if (c && c.size === st.size && c.mtimeMs === st.mtimeMs) return c.rows;
    const rows = fs.readFileSync(p, 'utf8').replace(/^﻿/, '').split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } });
    this.cache.set(p, { size: st.size, mtimeMs: st.mtimeMs, rows });
    return rows;
  }
  /** 全部记录，按 seq 排好。每行 {seq, role:'user'|'assistant', text, at, ...meta}。 */
  rows() { return this.volumes().flatMap(p => this.readVolume(p)); }
  /**
   * 记一句话。role 只能是 user 或 assistant；at 默认现在（ISO 字符串或毫秒）。
   * meta 里可以放渠道、消息编号等，原样存下。返回写进去的那一行。
   */
  append({ role, text, at, ...meta }) {
    if (role !== 'user' && role !== 'assistant') throw new Error('role 只能是 user 或 assistant');
    if (typeof text !== 'string' || !text.trim()) throw new Error('text 不能为空');
    const ms = at === undefined ? this.now() : typeof at === 'number' ? at : Date.parse(at);
    if (!Number.isFinite(ms)) throw new Error('at 不是有效时间');
    if (this.lastSeq === null) this.lastSeq = Number(this.rows().at(-1)?.seq || 0);
    const row = { seq: ++this.lastSeq, role, text, at: new Date(ms).toISOString(), ...meta };
    const month = new Date(ms + this.offset * 3600e3).toISOString().slice(0, 7);
    fs.appendFileSync(path.join(this.dir, month + '.jsonl'), JSON.stringify(row) + '\n', 'utf8');
    return row;
  }
}

/** 读写小 JSON / JSONL 文件的工具，几个模块共用。 */
export const files = {
  readText: p => { try { return fs.readFileSync(p, 'utf8').replace(/^﻿/, ''); } catch { return ''; } },
  readJson: (p, dflt = null) => { try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^﻿/, '')); } catch { return dflt; } },
  writeText: (p, t) => { fs.mkdirSync(path.dirname(p), { recursive: true }); const tmp = p + '.tmp'; fs.writeFileSync(tmp, t, 'utf8'); fs.renameSync(tmp, p); },
  writeJson: (p, v) => files.writeText(p, JSON.stringify(v)),
  appendJsonl: (p, v) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.appendFileSync(p, JSON.stringify(v) + '\n', 'utf8'); },
  readJsonl: p => files.readText(p).split('\n').filter(l => l.trim()).flatMap(l => { try { return [JSON.parse(l)]; } catch { return []; } }),
  exists: p => fs.existsSync(p),
};
