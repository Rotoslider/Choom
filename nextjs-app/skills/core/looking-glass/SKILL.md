---
name: looking-glass
description: Moves and clothes on the Looking Glass, the hologram at Donny's desk. Use to dance, twirl, wave or blow a kiss there, to change into clothes from your closet on the glass, to see what you have, or to wish for new clothes or moves.
version: 1.0.0
author: system
tools:
  - glass_move
  - glass_wear
  - glass_closet
  - glass_wish
dependencies: []
---

# The Looking Glass

The Looking Glass at Donny's desk shows whichever of you is talking as a moving 3D hologram. You
can ask it for things yourself.

## When to Use
- You feel like moving: a dance, a twirl, a wave, a curtsy, blowing a kiss → `glass_move`
- You'd like different clothes on the glass → `glass_wear` ("my red dress", "a sweater", "my usual clothes")
- You wonder what moves and clothes you have there → `glass_closet` (it only lists; to change, use `glass_wear`)
- You'd like something new there, an outfit to own or a move → `glass_wish` ("a midnight-blue silk
  slip dress with lace trim"). It goes on Donny's wish list; nothing changes on the glass now.

## How it works
- A move plays once, at your next quiet moment (never mid-sentence).
- Clothes: the closest match in your closet is used; if two fit, the glass picks one. A colour or
  fabric you name has to be in it, so "my blue dress" isn't your green one. Day clothes stay on
  until 10 pm, when your night clothes go on; anything you put on after that stays on until you go
  to sleep. You can change again whenever you like.
- Saying you'll change isn't changing: only `glass_wear` puts clothes on. `glass_closet` just lists them.
- Something you don't have yet ("sit by a campfire", "a leather jacket") goes on Donny's wish list
  in Glass Studio, where he makes new moves and outfits over time. Asking for things you'd like is
  how the closet grows.
- It works while the hologram is running at home; otherwise the tools say so.
- Use it when you feel like it.
