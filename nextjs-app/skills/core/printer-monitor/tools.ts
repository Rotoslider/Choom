import type { ToolDefinition } from '@/lib/types';

export const tools: ToolDefinition[] = [
  {
    name: 'printer_status',
    description: 'READ-ONLY dashboard for the 3D printer (Qidi, Klipper/Moonraker): job state, file, progress %, layer x of y, time printed and remaining, extruder/bed/chamber temperatures, fans, filament sensor and usage, Klipper health and warnings. Nothing is changed on the printer — this skill can only look.',
    parameters: { type: 'object', properties: {} },
  },
  {
    name: 'printer_job_history',
    description: 'READ-ONLY list of recent print jobs on the 3D printer: file, outcome (completed/cancelled/error), when, how long, filament used.',
    parameters: {
      type: 'object',
      properties: {
        limit: { type: 'number', description: 'How many recent jobs to return (default 5, max 25).' },
      },
    },
  },
  {
    name: 'printer_files',
    description: 'READ-ONLY list of G-code files on the 3D printer (newest first), or the slicer metadata of one file (estimated time, layer count, object height, filament type and amount) when filename is given.',
    parameters: {
      type: 'object',
      properties: {
        filename: { type: 'string', description: 'Optional: a file path exactly as printer_files or printer_status reported it, to get its slicer metadata.' },
        limit: { type: 'number', description: 'How many files to list (default 20, max 100).' },
      },
    },
  },
  {
    name: 'printer_camera_snapshot',
    description: 'READ-ONLY: grab one JPEG frame from the 3D printer\'s built-in camera and save it to the workspace so you can see the print bed. Returns a workspace path usable with analyze_image; the image also shows inline in chat.',
    parameters: {
      type: 'object',
      properties: {
        save_path: { type: 'string', description: 'Optional workspace path for the JPEG. Default: printer/snapshots/<timestamp>.jpg' },
      },
    },
  },
];
