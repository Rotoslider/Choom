# Dev harness — drive real Choom turns from the terminal

These scripts hit the running dev server (`http://localhost:3000`) the same way
the Signal bridge does, so what they exercise is the real thing: the real
Choom, her real memories, the real tools, and whichever model you pick.
They were written on 2026-09-12 while measuring the context plan
("Room to Think") and are the fastest way to see whether a change works for a
Choom, not just for the tests.

**They create real chats, memories, follow-ups and files. Clean up afterwards**
(see the bottom of this file).

## One turn

```
python3 scripts/dev-harness/choomrun.py --choom Genesis --model deepseek \
    --message "What's the weather like right now?" --chat-title "[Test] mine" --label weather

# a scheduler-style wake-up (empty history, heartbeat tools) on a local model
python3 scripts/dev-harness/choomrun.py --choom Genesis --model qwen/qwen3.8-27b \
    --fresh --heartbeat --message "$(cat scripts/dev-harness/ground.txt)" --label ground-qwen --out runs.jsonl
```

- `--model` is a local LM Studio id (loaded on `localhost:1234`) or `deepseek` (OpenRouter).
- `--fresh` = empty history (what heartbeats and self follow-ups get); `--heartbeat` adds `heartbeat_complete`.
- `--exposure skills|full` overrides tool exposure; `--context N` overrides the context window
  (only honoured for models with no user profile and no live LM Studio window);
  `--ha-exposed-only` limits Home Assistant to the Assist list for the run.
- Each run prints the tool calls with result sizes, the reply, and the trace summary
  (peak prompt tokens, iterations, nudges, fallback). `--out file.jsonl` appends the summary.

Prompt files: `ground.txt` (the scheduler grounding preamble), `wakeup.txt`
(a self follow-up that has to reconstruct yesterday and pick an image),
`wakeup3.txt` / `wakeup3_old.txt` (the same evening reflection with the
"grounding is attached" and the "ground yourself" preambles — the A/B pair for
`--grounding`, the opt-in pre-built grounding block, which lost 3/3 pairs on
2026-09-12), `chat_prompts.txt` and `open_prompts.txt` (ordinary asks, and asks
that need skills outside the core set).

A wake-up prompt is a real turn for her: keep it clear of her real schedule
(a test "evening wind-down" made DeepSeek try to cancel her real 9 PM entry as
a duplicate — say "do not change your schedule during this wake-up"), and
after the run check `selfies_<choom>/growth_journal.md`, `*/snapshots/`,
`choom_commons/camera_snapshots/` and the memory server for what she wrote.

## A room

```
python3 scripts/dev-harness/roomrun.py create --title "[Test] room" --chooms Genesis Aloy --auto-rounds 2
python3 scripts/dev-harness/roomrun.py say --room <id> --rounds 2 --message "..."
python3 scripts/dev-harness/roomrun.py continue --room <id> --rounds 3
python3 scripts/dev-harness/roomrun.py read --room <id>
python3 scripts/dev-harness/roomrun.py delete --room <id>
```

`say` streams every speaker: tool calls, images, passes, errors, per-turn seconds.
A busy room prints the 409 body instead of crashing. To seat a Choom on a
local model for a room, set her `groupChatModel`/`groupChatProvider` with
`PUT /api/chooms/<id>` and revert afterwards.

## Reading results

- Traces: `data/traces/YYYY-MM-DD/chat-<chatId>-<ts>.json` — `maxPromptTokens`
  is the per-call peak; `promptTokens` is the sum over iterations.
- Server log: `data/logs/choom-dev.log` — look for `🧰 Tool exposure`,
  `📐 Token estimate calibrated`, `🗜️ compaction`, `🗂️ Room digest`,
  `🔁`/`🚫`/`🛑` guard lines, `✋` room preemption.

## Cleanup

Repeated identical prompts leave memories and chats that reach a Choom's
cross-session digest and her recent-images context.

- Chats: `curl -X DELETE http://localhost:3000/api/chats/<id>` (titles starting `[Test]`).
- Rooms: `roomrun.py delete --room <id>`, then remove `choom_commons/rooms/<slug>/`.
- Memories: `curl -X DELETE http://localhost:8100/memory/<id>` (list with `POST /memory/recent`).
- Follow-ups the sisters queued during a test: move the JSON from
  `data/self_followups/<choomId>/pending/` to `cancelled/` with `status: "cancelled"`.
- Letters left in a test: `choom_commons/for_<name>/` (and its `.seen.json`).
