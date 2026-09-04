## vllm

__URL__: http://localhost:8000

```bash
export PYTHONIOENCODING=utf-8 && curl -s -N http://localhost:8000/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"local-llm","messages":[{"role":"user","content":"explain stormlight archive in 10000 words."}],"temperature":0.7,"stream":true,"stream_options":{"include_usage":true}}' | python3 -u -c '
import sys, json
for line in sys.stdin:
    if not line.startswith("data: "): continue
    body = line[6:].strip()
    if body == "[DONE]": print(); break
    d = json.loads(body)
    if d.get("usage"): print("\n\n--", d["usage"]); continue
    for ch in d.get("choices", []):
        t = ch["delta"].get("content")
        if t: print(t, end="", flush=True)
'
```

## ollama

__URL__: http://localhost:11434

```bash
export PYTHONIOENCODING=utf-8 && curl -s -N http://localhost:11434/api/chat -H 'Content-Type: application/json' -d '{"model":"qwen3:8b-q8_0","messages":[{"role":"user","content":"explain stormlight archive in 10000 words."}],"temperature":0.7,"stream":true,"think":false,"options":{"num_predict":4096}}' | python -u -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line: continue
    d = json.loads(line)
    t = d.get("message", {}).get("content")
    if t: print(t, end="", flush=True)
    if d.get("done"):
        pe, pd = d.get("prompt_eval_count",0), d.get("prompt_eval_duration",0)
        ec, ed = d.get("eval_count",0), d.get("eval_duration",0)
        print("\n\n-- prompt %d tok in %.2fs = %.1f tok/s" % (pe, pd/1e9, pe/(pd/1e9) if pd else 0))
        print("-- decode %d tok in %.2fs = %.1f tok/s" % (ec, ed/1e9, ec/(ed/1e9) if ed else 0))
        print("-- load %.2fs  total %.2fs  reason %s" % (d.get("load_duration",0)/1e9, d.get("total_duration",0)/1e9, d.get("done_reason")))
'
```

## llama.cpp

__URL__: http://localhost:8080

```bash
export PYTHONIOENCODING=utf-8 && curl -s -N http://localhost:8080/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"qwen3-8b-q8","messages":[{"role":"user","content":"explain stormlight archive in 10000 words."}],"temperature":0.7,"stream":true,"stream_options":{"include_usage":true},"chat_template_kwargs":{"enable_thinking":false},"max_tokens":4096}' | python -u -c '
import sys, json
fin = None
for line in sys.stdin:
    if not line.startswith("data: "): continue
    body = line[6:].strip()
    if body == "[DONE]": print(); break
    d = json.loads(body)
    for ch in d.get("choices", []):
        t = ch.get("delta", {}).get("content")
        if t: print(t, end="", flush=True)
        if ch.get("finish_reason"): fin = ch["finish_reason"]
    tm = d.get("timings")
    if tm:
        print("\n\n-- prompt %d tok in %.2fs = %.1f tok/s (%d cached)" % (tm.get("prompt_n",0), tm.get("prompt_ms",0)/1e3, tm.get("prompt_per_second") or 0, tm.get("cache_n",0)))
        print("-- decode %d tok in %.2fs = %.1f tok/s" % (tm.get("predicted_n",0), tm.get("predicted_ms",0)/1e3, tm.get("predicted_per_second") or 0))
    u = d.get("usage")
    if u: print("-- total %d tok  reason %s" % (u.get("total_tokens",0), fin))
'
```

## lm studio

__URL__: http://localhost:1234

Start the LM Studio Developer server and load Qwen3 8B before running this
request. The request uses LM Studio's native REST API, sets a 32,768-token
context, disables Qwen3 reasoning, and streams the generated answer.

Start `npm run lmstudio` before this request if you want the monitor to capture
the ongoing state and completed-request statistics through `lms log stream`.

```bash
lms load qwen/qwen3-8b --context-length 32768
lms server start --port 1234

export PYTHONIOENCODING=utf-8 && curl -s -N http://localhost:1234/api/v1/chat -H 'Content-Type: application/json' -d '{"model":"qwen/qwen3-8b","input":"explain stormlight archive in 10000 words.","temperature":0.7,"reasoning":"off","context_length":32768,"max_output_tokens":4096,"stream":true}' | python3 -u -c '
import sys, json
for line in sys.stdin:
    line = line.strip()
    if not line.startswith("data: "): continue
    d = json.loads(line[6:])
    kind = d.get("type")
    if kind == "message.delta":
        t = d.get("content")
        if t: print(t, end="", flush=True)
    elif kind == "chat.end":
        stats = d.get("result", {}).get("stats", {})
        print("\n\n-- input %d tok  output %d tok" % (stats.get("input_tokens",0), stats.get("total_output_tokens",0)))
        print("-- output %.1f tok/s  ttfb %.2fs" % (stats.get("tokens_per_second",0), stats.get("time_to_first_token_seconds",0)))
        print("-- load %.2fs" % stats.get("model_load_time_seconds",0))
        break
    elif kind == "error":
        print("\n\n-- error %s" % d.get("error"), file=sys.stderr)
        break
'
```

## amd lemonade

__URL__: http://localhost:13305

```bash
export PYTHONIOENCODING=utf-8 && curl -s -N http://localhost:13305/api/v1/chat/completions -H 'Content-Type: application/json' -d '{"model":"Qwen3-8B-GGUF-Q8_0","messages":[{"role":"user","content":"explain stormlight archive in 10000 words."}],"temperature":0.7,"stream":true,"max_tokens":4096,"chat_template_kwargs":{"enable_thinking":false}}' | python -u -c '
import sys, json
for line in sys.stdin:
    if not line.startswith("data: "): continue
    body = line[6:].strip()
    if body == "[DONE]": print(); break
    d = json.loads(body)
    for ch in d.get("choices", []):
        t = ch.get("delta", {}).get("content")
        if t: print(t, end="", flush=True)
'
```
