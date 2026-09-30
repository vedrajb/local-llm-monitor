export const args = process.argv.slice(2);
function opt(name, def) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
export const VLLM_HOST = opt('--vllm-host', process.env.VLLM_HOST || 'http://localhost:8000').replace(/\/$/, '');
// OLLAMA_HOST is conventionally set without a scheme (e.g. "127.0.0.1:11434"),
// which fetch() rejects, so add one when it is missing.
export const OLLAMA_HOST = opt('--ollama-host', process.env.OLLAMA_HOST || 'http://localhost:11434')
  .replace(/^(?!https?:\/\/)/i, 'http://')
  .replace(/\/$/, '');
// llama.cpp binds 127.0.0.1:8080 by default. Its own LLAMA_ARG_HOST holds a
// bare address rather than a URL, so it is deliberately not read here.
export const LLAMACPP_HOST = opt('--llamacpp-host', process.env.LLAMACPP_HOST || 'http://localhost:8080')
  .replace(/^(?!https?:\/\/)/i, 'http://')
  .replace(/\/$/, '');
export const LEMONADE_HOST = opt('--lemonade-host', process.env.LEMONADE_HOST || 'http://localhost:13305')
  .replace(/^(?!https?:\/\/)/i, 'http://')
  .replace(/\/$/, '');
export const LEMONADE_API_KEY = opt('--lemonade-api-key', process.env.LEMONADE_API_KEY || null);
export const LEMONADE_HEADERS = LEMONADE_API_KEY
  ? { Authorization: `Bearer ${LEMONADE_API_KEY}` }
  : undefined;
export const LMSTUDIO_HOST = opt(
  '--lmstudio-host',
  process.env.LMSTUDIO_HOST || process.env.LM_STUDIO_HOST || 'http://localhost:1234'
)
  .replace(/^(?!https?:\/\/)/i, 'http://')
  .replace(/\/$/, '');
export const LMSTUDIO_API_KEY = opt(
  '--lmstudio-api-key',
  process.env.LMSTUDIO_API_KEY || process.env.LM_STUDIO_API_KEY || null
);
export const LMSTUDIO_HEADERS = LMSTUDIO_API_KEY
  ? { Authorization: `Bearer ${LMSTUDIO_API_KEY}` }
  : undefined;
export const OPENCLAW_HOST = opt('--openclaw-host', process.env.OPENCLAW_HOST || 'http://127.0.0.1:18789')
  .replace(/^(?!https?:\/\/)/i, 'http://')
  .replace(/\/$/, '');
export const OLLAMA_LOG = opt('--ollama-log', process.env.OLLAMA_LOG || null);
export const INTERVAL = parseInt(opt('--interval', '2000'), 10);
export const ONCE = args.includes('--once');
export const PLAIN = args.includes('--plain');
export const PLATFORM = opt('--platform', process.env.LLM_PLATFORM || null);
export const KEEP_AWAKE = !args.includes('--no-keep-awake');
