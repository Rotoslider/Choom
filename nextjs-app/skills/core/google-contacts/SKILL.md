---
name: google-contacts
description: Search and look up Google Contacts. Use when the user asks about contacts, phone numbers, or email addresses for people they know.
version: 1.0.0
author: system
tools:
  - search_contacts
  - get_contact
dependencies: []
---

# Google Contacts

## When to Use
- Find a contact -> `search_contacts` (search by name or email)
- Get full contact details -> `get_contact` (needs resource_name from search)

## Important
- Requires People API enabled in Google Cloud Console
- OAuth scopes: contacts.readonly (read-only access)
- Resource names look like "people/c1234567890"
- Returns names, email addresses, phone numbers, organizations, addresses
