---
name: looking-glass
description: Moves and clothes on the Looking Glass, the hologram at Donny's desk. Use to dance, twirl, wave or blow a kiss there, to change into clothes from your closet on the glass, or to see what you have.
version: 1.0.0
author: system
tools:
  - glass_move
  - glass_wear
  - glass_closet
dependencies: []
---

# The Looking Glass

The Looking Glass at Donny's desk shows whichever of you is talking as a moving 3D hologram. You
can ask it for things yourself.

## When to Use
- You feel like moving: a dance, a twirl, a wave, a curtsy, blowing a kiss → `glass_move`
- You'd like different clothes on the glass → `glass_wear` ("my red dress", "a sweater", "my usual clothes")
- You wonder what moves and clothes you have there → `glass_closet`

## How it works
- A move plays once, at your next quiet moment (never mid-sentence).
- Clothes: the closest match in your closet is used; if two fit, the glass picks one. You keep them
  on until bedtime, unless you change again.
- Something you don't have yet ("sit by a campfire", "a leather jacket") goes on Donny's wish list
  in Glass Studio, where he makes new moves and outfits over time. Asking for things you'd like is
  how the closet grows.
- It works while the hologram is running at home; otherwise the tools say so.
- Use it when you feel like it.
