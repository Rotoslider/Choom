// GPU Busy Tracking
// Tracks when long-running GPU commands (training, inference) are active
// so that image generation can detect contention and defer.

let activeGpuCommands = 0;
let gpuBusyReason = '';

/**
 * Check if the GPU is currently occupied by a long-running command.
 */
export function isGpuBusy(): { busy: boolean; reason: string } {
  return { busy: activeGpuCommands > 0, reason: gpuBusyReason };
}

/**
 * Mark GPU as busy (call when starting a long-running GPU command).
 */
export function markGpuBusy(reason: string): void {
  activeGpuCommands++;
  gpuBusyReason = reason;
  console.log(`   🔒 GPU marked busy (${activeGpuCommands} active): ${reason}`);
}

/**
 * Release GPU busy mark (call when long-running GPU command finishes).
 */
export function markGpuFree(): void {
  activeGpuCommands = Math.max(0, activeGpuCommands - 1);
  if (activeGpuCommands === 0) gpuBusyReason = '';
  console.log(`   🔓 GPU released (${activeGpuCommands} active)`);
}
