// 错误类型统计：每次对账后，把判错的句子按“错在哪”归类，逐周攒起来，报告里附最近 6 周走势。
// 不调模型：类型从校对模型写的 problem 文字和判定里按规则认出来。
// 校对模型本身不全准，所以这里统计的是“判的错”；AI 拿疑点改没改（上周疑点的结果）当旁证一起记。
// 用途：看哪类错反复出现，再据此改整理规则。
import { resolveLabels, esc } from './text.mjs';

export const ERROR_KINDS = ['AI的话算成用户的', '用户的话算成AI的', '谁对谁弄反', '视频剧情当成真事', '先后细节对不上', '找不到依据', '过时'];

function patterns(labels, aiName) {
  const L = resolveLabels(labels), U = esc(L.user), A = [esc(L.ai), aiName && esc(aiName), 'AI'].filter(Boolean).join('|'), S = esc(L.self);
  return {
    AI: new RegExp(`(是|都是|其实是|实际是)(${A})|(${A})(先|自己|才是|说|提|问)|(${A})在\\s*#?\\d+`),
    NOT_USER: new RegExp(`不是${U}|${U}只|${U}后来|${U}才|${U}没|${U}就回|${U}回了|${U}接|没有${U}|(写成|归成|算成|安到了?)${U}`),
    USER: new RegExp(`(是|其实是|实际是)${U}|${U}(先|自己)`),
    NOT_AI: new RegExp(`不是(${A}|${S})|与记录相反|正好相反`),
    SWAP: new RegExp(`不是${U}(让|给|带|对|画|把|定|请)|不是(${A})(让|给|对|定|请)|反过来|(${A})(把.{0,6})?(交给|让|叫)${U}|谁请|谁定|谁提`),
    AI_SAID: new RegExp(`^“?[^”]*”?是(${A})(在\\s*#?\\d+)?说的`),
    SELF_SAYS: new RegExp(`${S}(说|先|提|要|想)`),
    USER_SAYS: new RegExp(`${U}(说|问|答应|讲|想|喜欢)`),
  };
}
const ORDER = /之前|之后|随后|还没|紧接着|先后|顺序|不是.{0,6}(之后|以后|接着)/;
const VIDEO = /视频|二创|角色|剧情|片子|标题/;

/** 一条判错归到哪一类。r：{verdict, problem, text}。 */
export function errorKind(r, { labels, aiName } = {}) {
  const P = patterns(labels, aiName), p = String(r.problem || ''), v = r.verdict;
  if (v === '过时') return '过时';
  if (v === '张冠李戴' || (VIDEO.test(p) && /不是.{0,3}本人|不是.{0,3}的事|角色反应/.test(p))) return '视频剧情当成真事';
  if (P.SWAP.test(p) && !P.AI_SAID.test(p)) return '谁对谁弄反';
  if (P.AI.test(p) && P.NOT_USER.test(p)) return 'AI的话算成用户的';
  if (P.USER.test(p) && P.NOT_AI.test(p)) return '用户的话算成AI的';
  // 笔记大多写的是“他”，说话人搞反默认是 AI 的话算成用户的；只有笔记写“我说/我先”又不提他时才算反方向
  if (v === '说话人搞反') return P.SELF_SAYS.test(r.text) && !P.USER_SAYS.test(r.text) ? '用户的话算成AI的' : 'AI的话算成用户的';
  if (ORDER.test(p)) return '先后细节对不上';
  if (v === '找不到依据' || /没有.{0,10}(记录|依据)/.test(p)) return '找不到依据';
  return '先后细节对不上';
}

const isFlag = r => r.gate === 'report' || r.gate === 'auto';

/** 一周的统计行。results：本周对账结果；applied：自动改了的；prevDoubts：上周疑点（AI 用过之后的样子）；speaker(text)：可选的机械检查。 */
export function weekStats({ week, at, results, applied = [], prevDoubts = null, speaker, labels, aiName }) {
  const flagged = results.filter(isFlag);
  const byKind = Object.fromEntries(ERROR_KINDS.map(k => [k, 0])), bySec = {}, items = [];
  for (const r of flagged) {
    const k = errorKind(r, { labels, aiName }); byKind[k]++;
    bySec[r.sec] = (bySec[r.sec] || 0) + 1;
    items.push({ kind: k, sec: r.sec, verdict: r.verdict, auto: r.gate === 'auto', text: String(r.text).slice(0, 60) });
  }
  const row = { week, at, checked: results.filter(r => r.gate !== 'skip').length, skipped: results.filter(r => r.gate === 'skip').length, flagged: flagged.length, auto: applied.length, byKind, bySec, items };
  if (speaker) row.speakerMech = results.filter(r => r.gate !== 'skip' && speaker(r.text).length).length;
  if (prevDoubts?.consumed) row.prevDoubts = { week: prevDoubts.week, items: prevDoubts.items?.length || 0, changed: prevDoubts.changed || 0, kept: (prevDoubts.kept || []).length };
  return row;
}

/** 报告末尾的走势表：最近 6 周每类各几句。连着两周都有、或一周 3 句以上的类型标“反复出现”。 */
export function trendMd(rows) {
  const last = rows.slice(-6); if (!last.length) return '';
  const pct = (a, b) => b ? Math.round(a * 100 / b) + '%' : '-';
  const L = ['## 错误类型统计', '', '按校对模型的判定归类（模型不全准，数字是“判的错”，不全是真错）。', '',
    '| 类型 | ' + last.map(r => r.week).join(' | ') + ' |', '|---|' + last.map(() => '---|').join('')];
  for (const k of ERROR_KINDS) if (last.some(r => r.byKind?.[k])) L.push(`| ${k} | ` + last.map(r => r.byKind?.[k] || 0).join(' | ') + ' |');
  L.push('| **合计判错** | ' + last.map(r => r.flagged).join(' | ') + ' |', '| 查了几句 | ' + last.map(r => r.checked).join(' | ') + ' |', '| 判错率 | ' + last.map(r => pct(r.flagged, r.checked)).join(' | ') + ' |');
  if (last.some(r => r.speakerMech !== undefined)) L.push('| 机械检查：含只有 AI 说过的原话 | ' + last.map(r => r.speakerMech ?? '-').join(' | ') + ' |');
  if (last.some(r => r.prevDoubts)) L.push('| 上周疑点改了 / 留着 | ' + last.map(r => r.prevDoubts ? `${r.prevDoubts.changed} / ${r.prevDoubts.kept}` : '-').join(' | ') + ' |');
  L.push('');
  const cur = last.at(-1), prev = last.at(-2), top = ERROR_KINDS.filter(k => cur.byKind?.[k]).sort((a, b) => cur.byKind[b] - cur.byKind[a]);
  if (top.length) L.push(`本周最多的是「${top[0]}」${cur.byKind[top[0]]} 句。`);
  const hot = ERROR_KINDS.filter(k => (cur.byKind?.[k] || 0) >= 3 || ((cur.byKind?.[k] || 0) >= 1 && (prev?.byKind?.[k] || 0) >= 1));
  if (hot.length) L.push(`反复出现：${hot.map(k => `「${k}」`).join('、')}。`);
  return L.join('\n') + '\n';
}
