import { httpFetch, num, pluck, postJson, renderMessage } from '../http';
import { AUTH_SCHEMA, authHeaders } from './authn';
import { need, S, type ModelImpl, type PluginDef } from './types';

const LLM_COMMON = {
  model: S.str('Model name'),
  temperature: S.num('Temperature', 0.2, { minimum: 0, maximum: 2 }),
  maxTokens: S.num('Max output tokens', 800),
};

// ── Anthropic ────────────────────────────────────────────────────────────────
const anthropic: ModelImpl = {
  async complete(ctx, system, prompt) {
    need(ctx.config, 'apiKey');
    const r = await postJson<{ content: { type: string; text?: string }[] }>(
      `${ctx.config.baseUrl || 'https://api.anthropic.com'}/v1/messages`,
      { model: ctx.config.model || 'claude-sonnet-5-5', max_tokens: Number(ctx.config.maxTokens ?? 800), temperature: Number(ctx.config.temperature ?? 0.2), system, messages: [{ role: 'user', content: prompt }] },
      { headers: { 'x-api-key': ctx.config.apiKey, 'anthropic-version': '2023-06-01' }, timeoutMs: 90_000 },
    );
    return r.content.filter((c) => c.type === 'text').map((c) => c.text).join('');
  },
  async test(ctx) { return `Reply: ${(await anthropic.complete!(ctx, 'Reply with one word.', 'Say OK')).slice(0, 60)}`; },
};

// ── OpenAI-compatible (OpenAI, Gemini, Mistral, Groq, Together, OpenRouter, HF, Ollama, LM Studio, vLLM …) ──
const openaiCompat: ModelImpl = {
  async complete(ctx, system, prompt) {
    need(ctx.config, 'baseUrl', 'model');
    const headers: Record<string, string> = ctx.config.apiKey ? { Authorization: `Bearer ${ctx.config.apiKey}` } : {};
    const r = await postJson<{ choices: { message: { content: string } }[] }>(
      `${String(ctx.config.baseUrl).replace(/\/$/, '')}/chat/completions`,
      { model: ctx.config.model, temperature: Number(ctx.config.temperature ?? 0.2), max_tokens: Number(ctx.config.maxTokens ?? 800), messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] },
      { headers, timeoutMs: 120_000 },
    );
    return r.choices?.[0]?.message?.content ?? '';
  },
  async test(ctx) { return `Reply: ${(await openaiCompat.complete!(ctx, 'Reply with one word.', 'Say OK')).slice(0, 60)}`; },
};

function compatPreset(id: string, name: string, baseUrl: string, docsUrl: string, keyRequired: boolean, modelHint: string, category = 'LLM providers'): PluginDef {
  return {
    id, kind: 'model', name, category, docsUrl, source: 'builtin', capabilities: { llm: true },
    description: `OpenAI-compatible chat endpoint at ${baseUrl}`,
    configSchema: S.obj({ baseUrl: S.url('Base URL', baseUrl), apiKey: S.secret(keyRequired ? 'API key' : 'API key (optional)'), ...LLM_COMMON, model: S.str('Model name', { 'x-placeholder': modelHint }) }, keyRequired ? ['apiKey', 'model'] : ['model']),
    impl: openaiCompat,
  };
}

// ── Replicate ────────────────────────────────────────────────────────────────
const replicate: ModelImpl = {
  async complete(ctx, system, prompt) {
    need(ctx.config, 'apiKey', 'model');
    const r = await postJson<{ output?: string[] | string; error?: string }>(
      `https://api.replicate.com/v1/models/${ctx.config.model}/predictions`,
      { input: { prompt, system_prompt: system, max_new_tokens: Number(ctx.config.maxTokens ?? 800), temperature: Number(ctx.config.temperature ?? 0.2) } },
      { headers: { Authorization: `Bearer ${ctx.config.apiKey}`, Prefer: 'wait=60' }, timeoutMs: 90_000 },
    );
    if (r.error) throw new Error(r.error);
    return Array.isArray(r.output) ? r.output.join('') : r.output ?? '';
  },
  async test(ctx) { return `Reply: ${(await replicate.complete!(ctx, 'Reply with one word.', 'Say OK')).slice(0, 60)}`; },
};

// ── Generic HTTP forecast model ──────────────────────────────────────────────
const httpForecast: ModelImpl = {
  async forecast(ctx, closes, dates, horizon) {
    const c = ctx.config;
    need(c, 'url');
    const body = renderMessage(c.bodyTemplate || '{"series": {{series}}, "dates": {{dates}}, "horizon": {{horizon}}}', { series: closes, dates, horizon });
    const res = await httpFetch(c.url, { method: 'POST', body, headers: { 'Content-Type': 'application/json', Accept: 'application/json', ...(await authHeaders(c, ctx.connectionId)) }, timeoutMs: 60_000 });
    const json = await res.json();
    const arr = pluck(json, c.forecastPath || 'forecast');
    if (!Array.isArray(arr)) throw new Error(`Forecast path "${c.forecastPath || 'forecast'}" did not resolve to an array`);
    const out = arr.map((v) => (typeof v === 'object' ? num(pluck(v, c.valueField || 'p50')) : num(v)));
    if (out.length < horizon || out.some((v) => !Number.isFinite(v))) throw new Error(`Endpoint returned ${out.length} values, needed ${horizon} numbers`);
    return out.slice(0, horizon);
  },
  async test(ctx) {
    const closes = Array.from({ length: 120 }, (_, i) => 100 + Math.sin(i / 6) * 5 + i * 0.1);
    const dates = closes.map((_, i) => new Date(Date.UTC(2020, 0, 1 + i)).toISOString().slice(0, 10));
    const f = await httpForecast.forecast!(ctx, closes, dates, 5);
    return `Forecast OK: ${f.map((v) => v.toFixed(2)).join(', ')}`;
  },
};

export const MODEL_PLUGINS: PluginDef[] = [
  {
    id: 'anthropic', kind: 'model', name: 'Anthropic Claude', category: 'LLM providers', docsUrl: 'https://docs.anthropic.com/en/api/messages', source: 'builtin',
    description: 'Claude models via the Messages API. Powers the LLM analyst signal.', capabilities: { llm: true },
    configSchema: S.obj({ apiKey: S.secret('API key'), ...LLM_COMMON, model: S.str('Model name', { default: 'claude-sonnet-5-5' }), baseUrl: S.url('Base URL', 'https://api.anthropic.com') }, ['apiKey']),
    impl: anthropic,
  },
  compatPreset('openai', 'OpenAI', 'https://api.openai.com/v1', 'https://platform.openai.com/docs/api-reference/chat', true, 'your OpenAI model id'),
  compatPreset('gemini', 'Google Gemini', 'https://generativelanguage.googleapis.com/v1beta/openai', 'https://ai.google.dev/gemini-api/docs/openai', true, 'your Gemini model id'),
  compatPreset('mistral', 'Mistral', 'https://api.mistral.ai/v1', 'https://docs.mistral.ai/api/', true, 'mistral-large-latest'),
  compatPreset('groq', 'Groq', 'https://api.groq.com/openai/v1', 'https://console.groq.com/docs/openai', true, 'a Groq-hosted model id'),
  compatPreset('together', 'Together AI', 'https://api.together.xyz/v1', 'https://docs.together.ai/docs/openai-api-compatibility', true, 'a Together model id'),
  compatPreset('openrouter', 'OpenRouter', 'https://openrouter.ai/api/v1', 'https://openrouter.ai/docs', true, 'anthropic/claude-sonnet-5-5'),
  compatPreset('huggingface', 'Hugging Face Inference', 'https://router.huggingface.co/v1', 'https://huggingface.co/docs/inference-providers', true, 'an HF model id'),
  compatPreset('ollama', 'Ollama (local)', 'http://localhost:11434/v1', 'https://github.com/ollama/ollama/blob/main/docs/openai.md', false, 'llama3.1', 'Local models'),
  compatPreset('lmstudio', 'LM Studio (local)', 'http://localhost:1234/v1', 'https://lmstudio.ai/docs/api', false, 'loaded model id', 'Local models'),
  compatPreset('openai_compat', 'Any OpenAI-compatible endpoint', 'http://localhost:8000/v1', 'https://platform.openai.com/docs/api-reference/chat', false, 'model id', 'Generic'),
  {
    id: 'replicate', kind: 'model', name: 'Replicate', category: 'LLM providers', docsUrl: 'https://replicate.com/docs/reference/http', source: 'builtin',
    description: 'Any Replicate-hosted language model (owner/name).', capabilities: { llm: true },
    configSchema: S.obj({ apiKey: S.secret('API token'), ...LLM_COMMON, model: S.str('Model (owner/name)', { 'x-placeholder': 'meta/meta-llama-3-70b-instruct' }) }, ['apiKey', 'model']),
    impl: replicate,
  },
  {
    id: 'http_forecast', kind: 'model', name: 'Custom HTTP forecast model', category: 'Generic', source: 'builtin',
    description: 'Your own model behind an HTTP endpoint: we POST the price series, it returns the next N values. Evaluated against naive like every model.',
    capabilities: { forecast: true },
    configSchema: S.obj({
      url: S.url('Endpoint URL'),
      bodyTemplate: S.text('Request body template', '{"series": {{series}}, "dates": {{dates}}, "horizon": {{horizon}}}'),
      forecastPath: S.str('Forecast array path', { default: 'forecast' }),
      valueField: S.str('Value field (if array items are objects)', { default: 'p50' }),
      evalOrigins: S.num('Backtest origins (API calls per evaluation)', 8, { minimum: 0, maximum: 30 }),
      ...AUTH_SCHEMA,
    }, ['url']),
    impl: httpForecast,
  },
];
