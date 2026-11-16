// 不用向量库的相关度：按二字组给资料打分，越少见的字组分越高。
// 聊天里到处都有、不说明话题的字组（“我的”“什么”“今天”）不算，否则记得越多越容易翻出不相干的东西。
// 对一个人几个月的聊天量来说，这样就够用，也不用额外装嵌入模型。

const FILLER = new Set('我的 你的 他的 她的 我们 你们 他们 什么 怎么 这个 那个 一个 一下 今天 明天 昨天 现在 就是 不是 没有 可以 还是 知道 觉得 感觉 时候 然后 因为 所以 但是 如果 已经 真的 好的 哈哈 了吗 了吧 了啊 完了 不错 还有 一样 这样 那样 有点 一点 不要 不会 可能 应该 是不 是的 的话 起来 出来 一起 他说 我说 你说 说的 的那 是什 么呢 么样 好像 还记 记得'.split(' '));

export function topicGrams(t) {
  const q = String(t).replace(/\s/g, ''), out = new Set();
  for (let i = 0; i < q.length - 1; i++) { const g = q.slice(i, i + 2); if (/[\p{L}\p{N}]{2}/u.test(g) && !FILLER.has(g)) out.add(g); }
  return out;
}

/**
 * 给 items 按和 query 的相关度排序。textOf(item) 取文字；min 是最低分；needed 是至少要中几个字组。
 * 返回 [{x, i, score}]，分高的在前，同分时新的在前。
 */
export function rankRelevant(items, textOf, query, min = 0.5, needed = 1) {
  const qs = [...topicGrams(query)]; if (!qs.length || !items.length) return [];
  const texts = items.map(x => String(textOf(x)).replace(/\s/g, '')), n = items.length, need = Math.min(needed, qs.length);
  const df = new Map(qs.map(g => [g, texts.reduce((c, t) => c + (t.includes(g) ? 1 : 0), 0)]));
  return items.map((x, i) => { let s = 0, h = 0; for (const g of qs) if (texts[i].includes(g)) { h++; s += Math.log((n + 1) / (df.get(g) + 1)); } return { x, i, score: h >= need ? s : 0 }; })
    .filter(r => r.score >= min).sort((a, b) => b.score - a.score || b.i - a.i);
}
