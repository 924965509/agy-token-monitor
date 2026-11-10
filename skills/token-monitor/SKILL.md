---
name: token-monitor
description: Open the real-time Token Speed & Usage Monitor sidecar panel in the auxiliary side pane, or analyze token speed (tok/s), context usage, and cache hit rate from conversation transcripts.
---

# Token Speed & Usage Monitor

Use this skill when the user asks to view token speed (`tok/s`), token usage, cache hit rate, or open the Token Monitor sidecar panel.

## 1. Surface the Sidecar Panel Pill

When the `agy-token-monitor` plugin and its `agy-token-monitor/monitor` sidecar are enabled, emit the clickable pill in chat so the user can toggle the real-time monitor in the right-hand auxiliary pane:

```markdown
[Token 速度监控](sidecar://agy-token-monitor/monitor/)
```

## 2. Direct CLI / Script Inspection

If the user asks for an immediate summary in chat, read `~/.gemini/antigravity/brain/<conversation-id>/.system_generated/logs/transcript.jsonl` and compute:
- `input_tokens`, `cache_read_tokens`, `output_tokens` per `PLANNER_RESPONSE`
- Cache Hit Rate: `cache_read_tokens / (input_tokens + cache_read_tokens)`
- Step duration (`Δt`) between a `PLANNER_RESPONSE` and its subsequent tool execution step (`GENERIC`), and `output_tokens / Δt` for `tok/s`.
