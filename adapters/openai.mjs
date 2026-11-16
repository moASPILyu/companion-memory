// 任何 OpenAI 兼容的 /chat/completions 接口（DeepSeek、OpenAI、通义、本地 vLLM/Ollama 的兼容接口都行）。
// key 从环境变量读，不写进代码和配置文件。
//
//   import { openaiLLM } from 'companion-memory/adapters/openai.mjs';
//   const llm = openaiLLM({ baseUrl: 'https://api.deepseek.com', model: 'deepseek-chat' });
//
// maxTokens 留够：整理笔记要输出两三千字，开了思考的模型还要再加。
// tokenCap：这个 llm 累计用量超过就抛错，防止脚本跑飞。
export function openaiLLM({ baseUrl, model, apiKey = process.env.MEMORY_LLM_KEY, maxTokens = 8000, extraBody = {}, tokenCap = Infinity, retries = 2, timeoutMs = 300e3 } = {}) {
  if (!baseUrl || !model) throw new Error('需要 baseUrl 和 model');
  if (!apiKey) throw new Error('没有 key：设置环境变量 MEMORY_LLM_KEY，或传 apiKey');
  const usage = { prompt: 0, completion: 0, cached: 0, calls: 0 };
  const url = baseUrl.replace(/\/+$/, '') + '/chat/completions';
  async function llm(system, user) {
    if (usage.prompt + usage.completion > tokenCap) throw new Error('超过 tokenCap');
    let last;
    for (let t = 0; t <= retries; t++) {
      try {
        const r = await fetch(url, {
          method: 'POST', signal: AbortSignal.timeout(timeoutMs),
          headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
          body: JSON.stringify({ model, max_tokens: maxTokens, messages: [{ role: 'system', content: system }, { role: 'user', content: user }], ...extraBody }),
        });
        if (!r.ok) throw new Error(`HTTP ${r.status}: ${(await r.text()).slice(0, 200)}`);
        const j = await r.json();
        usage.calls++; usage.prompt += j.usage?.prompt_tokens || 0; usage.completion += j.usage?.completion_tokens || 0;
        usage.cached += j.usage?.prompt_cache_hit_tokens || j.usage?.prompt_tokens_details?.cached_tokens || 0;
        return j.choices?.[0]?.message?.content ?? '';
      } catch (e) { last = e; if (t < retries) await new Promise(res => setTimeout(res, 2000 * (t + 1))); }
    }
    throw last;
  }
  llm.usage = usage;
  return llm;
}
