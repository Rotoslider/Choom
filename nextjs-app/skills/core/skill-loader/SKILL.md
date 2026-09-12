---
name: skill-loader
description: Loads another skill's tools into the current conversation and returns its instructions (only some tools are loaded at a time)
version: 1.0.0
author: system
tools:
  - open_skill
dependencies: []
---

## When to Use

Only some tools are loaded on each turn — your core tools plus the skills that
match the message. The AVAILABLE SKILLS list shows every skill and the tools it
holds. When you need a tool that is not currently loaded, call `open_skill`
with the skill's name. The skill's tools become available for the rest of the
turn and the result carries the skill's instructions. Then call the tool.

## Notes

- Never tell the user a tool is unavailable. Open its skill.
- Opening a skill is cheap; do it as soon as you know you need it.
- Tools you used earlier in this chat are loaded again automatically.
