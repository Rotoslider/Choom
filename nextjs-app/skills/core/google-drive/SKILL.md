---
name: google-drive
description: Manages Google Drive files and folders — list, search, create folders, upload from workspace, and download to workspace.
version: 1.0.0
author: system
tools:
  - list_drive_files
  - search_drive
  - create_drive_folder
  - upload_to_drive
  - download_from_drive
dependencies: []
---

# Google Drive

## When to Use
- Browse Drive → `list_drive_files`
- Find file → `search_drive`
- Create folder → `create_drive_folder`
- Back up workspace file → `upload_to_drive`
- Get Drive file → `download_from_drive` (Docs→text, Sheets→CSV)

## Important
- upload_to_drive takes workspace-relative path, resolves to absolute
- download_from_drive exports Google Docs as text, Sheets as CSV
- Path traversal prevention: paths must stay within workspace root
