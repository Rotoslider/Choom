---
name: notifications
description: Sends Signal message notifications to the user. Use when a long task is complete, something interesting was found, or user attention is needed.
version: 1.0.0
author: system
tools:
  - send_notification
dependencies: []
---

# Notifications

## When to Use
- Long task complete → `send_notification`
- Found something interesting → `send_notification`
- Need user attention → `send_notification`

## Image Attachments
When sending notifications about generated images, include the `image_ids` parameter with the IDs returned by `generate_image` or `save_generated_image`. This will attach the actual images to the Signal message so the user can see them on their phone.

Example: After generating images, call `send_notification` with `image_ids: ["cmlzfwg8y...", "cmlzfwvad..."]` to deliver them via Signal.
