---
name: printer-monitor
description: Read-only window onto the Qidi 3D printer (Klipper/Moonraker) — job progress, temperatures, filament, history, files, camera
version: 1.0.0
author: system
tools:
  - printer_status
  - printer_job_history
  - printer_files
  - printer_camera_snapshot
dependencies: []
---

## When to Use

Anything about the 3D printer in the shop: "how's the print doing", "what's printing", "how long left", "is the bed hot", "did the last print finish", "what files are on the printer", "show me the print".

**This skill can only look.** Every tool is a GET on a fixed allowlist of Moonraker paths. There is no tool, argument, or code path that starts, pauses, cancels, heats, homes, restarts or changes anything. If Donny wants the printer to *do* something, he does it at the printer or in the browser — say so plainly rather than trying.

### Level 1 — Quick Reference

- `printer_status` — the whole dashboard in one call: state, file, % and layer, time printed / left, extruder / bed / chamber temps, fans, filament, Klipper health. Use `formatted` for the plain-words answer.
- `printer_job_history` — last N jobs: outcome, when, how long, filament used.
- `printer_files` — G-code files on the printer; with `filename`, that file's slicer metadata (estimated time, layers, height, filament).
- `printer_camera_snapshot` — one JPEG from the printer's camera, saved to the workspace and shown inline. Follow with `analyze_image` to describe it.

### Level 2 — Reading the numbers

- **Progress**: `progress_percent` is what the printer's own display shows. `layer` comes from the slicer's layer messages (Qidi Studio sends them), so "layer 119 of 216" is exact.
- **Time left** is the slicer's estimate minus time printed (`time_remaining_basis: "slicer estimate"`); when the slicer gave none it is extrapolated from progress. Both drift on the first few layers — say "about".
- **Temperatures**: `power_percent` on a heater is how hard it is working. Extruder at target with ~10% power is normal steady-state (the sawtooth Home Assistant sees in the power draw). Bed and chamber holding target with low power is the printer keeping ASA/ABS warm.
- **Filament**: `detected: false` during a print means a runout — tell Donny right away. `used_g` is estimated from the slicer's totals for the file.
- **Klipper**: anything but `ready`, or any `warnings` / `failed_components`, is worth mentioning even if the print looks fine.
- `state` values: printing, paused, complete, cancelled, error, standby (idle).

### Endpoints (for the curious — all GET)

`/printer/objects/query?print_stats&extruder&…` (objects are bare query keys, NOT `targets=`), `/server/info`, `/server/files/metadata?filename=`, `/server/history/list`, `/server/files/list?root=gcodes`, `/server/webcams/list`, the webcam `?action=snapshot`. Note `/printer/queue/status` does not exist on Moonraker — that path was the source of earlier 404s.

Printer address: `MOONRAKER_URL` in .env (default http://192.168.1.139, the same box the browser dashboard runs on).
