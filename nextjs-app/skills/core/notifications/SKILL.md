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

## File Attachments
To send workspace files (PDFs, images, documents, spreadsheets, etc.) via Signal, include the `file_paths` parameter with relative workspace paths. Signal supports any file type — images display inline, other files appear as downloadable attachments.

Example: `send_notification` with `message: "Here's the report"` and `file_paths: ["my_project/report.pdf", "my_project/chart.png"]`

You can combine `image_ids` (for generated images) and `file_paths` (for workspace files) in the same notification. Use `file_paths` when you have a file on disk that the user needs on their phone.
