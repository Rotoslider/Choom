---
name: google-sheets
description: Manages Google Spreadsheets — list, create, read, write, and append data. Use for budgets, trackers, data tables, and CSV-like operations.
version: 1.0.0
author: system
tools:
  - list_spreadsheets
  - create_spreadsheet
  - read_sheet
  - write_sheet
  - append_to_sheet
dependencies: []
---

# Google Sheets

## When to Use
- Find spreadsheets → `list_spreadsheets`
- Create new → `create_spreadsheet` (with optional sheet_names and initial_data)
- Read data → `read_sheet` (A1 notation range)
- Overwrite range → `write_sheet`
- Add rows → `append_to_sheet`

## Important
- After creating, use the returned tab names (not "Sheet1") for read/write
- Range uses A1 notation: "Sheet1!A1:D10", "Income!A:D"
- values parameter is a 2D array: [["Name","Amount"],["Rent","1200"]]
