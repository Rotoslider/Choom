---
name: google-gmail
description: Read, send, search, and manage Gmail messages. Use when the user asks about email, inbox, or wants to send/reply to messages.
version: 1.0.0
author: system
tools:
  - list_emails
  - read_email
  - send_email
  - draft_email
  - search_emails
  - archive_email
  - reply_to_email
dependencies: []
---

# Google Gmail

## When to Use
- Check inbox -> `list_emails`
- Read specific email -> `read_email` (needs message_id from list/search)
- Draft/compose/write an email -> `draft_email` (saves to Drafts, does NOT send)
- Send email immediately -> `send_email` (only when user explicitly says "send")
- Search emails -> `search_emails` (Gmail search syntax: from:, subject:, is:unread, etc.)
- Archive email -> `archive_email` (removes from inbox)
- Reply to email -> `reply_to_email` (preserves thread)

## Important
- **ALWAYS prefer draft_email over send_email** unless the user explicitly says "send"
- "draft", "compose", "write", "prepare" an email -> use `draft_email`
- "send" an email -> use `send_email`
- Message IDs come from list_emails or search_emails results
- Gmail search syntax: from:user@example.com, subject:meeting, is:unread, has:attachment, newer_than:2d
