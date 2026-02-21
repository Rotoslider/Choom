---
name: image-generation
description: Generates images using Stable Diffusion with checkpoint switching, LoRA support, and self-portrait mode. Use when the user requests pictures, artwork, selfies, or portraits.
version: 1.0.0
author: system
tools:
  - generate_image
  - save_generated_image
dependencies: []
---

# Image Generation

## When to Use
- User requests image of themselves → `generate_image` with `self_portrait: true`
- User requests general image → `generate_image` with `self_portrait: false`
- Save generated image to project → `save_generated_image` with the `imageId` from generate_image result

## Self-Portrait Detection
Auto-detected from phrases: "selfie", "picture of me/you/yourself", "what do you look like"

## Size/Aspect Parameters
- size: "small" (768px), "medium" (1024px), "large" (1536px), "x-large" (1856px)
- aspect: "portrait" (3:4), "portrait-tall" (9:16), "square" (1:1), "landscape" (16:9), "wide" (21:9)

## Important
- Checkpoint switching is serialized via image generation lock to prevent race conditions
- LoRA models injected as `<lora:name:weight>` in prompt
- Dimensions must be divisible by 32
- Auto-detects checkpoint type from name (pony, flux, other) for CFG settings
