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
