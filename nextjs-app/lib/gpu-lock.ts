// GPU Busy Tracking
// Tracks when long-running GPU commands (training, inference) are active
// so that image generation can detect contention and defer.

let activeGpuCommands = 0;
let gpuBusyReason = '';
let lastGpuWaitTimestamp = 0; // Prevents repeated 180s waits in the same request

/**
 * Check if the GPU is currently occupied by a long-running command.
 */
export function isGpuBusy(): { busy: boolean; reason: string } {
  return { busy: activeGpuCommands > 0, reason: gpuBusyReason };
}

/**
 * Wait for the GPU to become free, polling at intervals.
 * On first call, waits up to maxWaitMs. If called again within cooldownMs
 * of a previous wait that failed, returns immediately (no second 180s wait).
 */
export async function waitForGpu(maxWaitMs = 180_000, pollIntervalMs = 10_000): Promise<{ free: boolean; waitedMs: number; reason: string }> {
  const status = isGpuBusy();
  if (!status.busy) return { free: true, waitedMs: 0, reason: '' };

  // If we already waited recently and GPU is still busy, fail immediately
  const cooldownMs = 300_000; // 5 minutes
  if (lastGpuWaitTimestamp > 0 && Date.now() - lastGpuWaitTimestamp < cooldownMs) {
    console.log(`   ⏳ GPU still busy — skipping wait (already waited ${Math.round((Date.now() - lastGpuWaitTimestamp) / 1000)}s ago)`);
    return { free: false, waitedMs: 0, reason: status.reason };
  }

  console.log(`   ⏳ GPU busy (${status.reason}) — waiting up to ${Math.round(maxWaitMs / 1000)}s for it to free up...`);
  const start = Date.now();

  while (Date.now() - start < maxWaitMs) {
    await new Promise(r => setTimeout(r, pollIntervalMs));
    const current = isGpuBusy();
    if (!current.busy) {
      const waited = Date.now() - start;
      console.log(`   ✅ GPU free after ${Math.round(waited / 1000)}s wait`);
      lastGpuWaitTimestamp = 0; // Reset on success
      return { free: true, waitedMs: waited, reason: '' };
    }
  }

  const waited = Date.now() - start;
  const current = isGpuBusy();
  lastGpuWaitTimestamp = Date.now(); // Record failed wait time
  console.log(`   ⚠️ GPU still busy after ${Math.round(waited / 1000)}s wait: ${current.reason}`);
  return { free: false, waitedMs: waited, reason: current.reason };
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
  if (activeGpuCommands === 0) {
    gpuBusyReason = '';
    lastGpuWaitTimestamp = 0; // Reset so next request can wait normally
  }
  console.log(`   🔓 GPU released (${activeGpuCommands} active)`);
}
