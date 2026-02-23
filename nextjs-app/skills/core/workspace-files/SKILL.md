---
name: workspace-files
description: Sandboxed file operations in project workspace — create projects, write, read, list, create folders, delete files, and rename projects. Use for saving reports, code, notes, or managing project files.
version: 1.1.0
author: system
tools:
  - workspace_write_file
  - workspace_read_file
  - workspace_list_files
  - workspace_create_folder
  - workspace_create_project
  - workspace_delete_file
  - workspace_rename_project
dependencies: []
---

# Workspace Files

## When to Use
- Start new project → `workspace_create_project` (creates folder + .choom-project.json)
- Save file → `workspace_write_file`
- Read file → `workspace_read_file`
- Browse workspace → `workspace_list_files`
- Create directory → `workspace_create_folder`
- Remove file → `workspace_delete_file`
- Rename project → `workspace_rename_project`

## Important
- **Always use workspace_create_project first** before writing project files
- All paths are relative to workspace root (~/choom-projects)
- Use the project folder as prefix for all file paths (e.g., "my_project/notes.md")
- Use underscores instead of spaces in folder names
- Session file creation limit enforced
- Path traversal prevention active
