/**
 * Tool error classification for the agentic loop.
 *
 * The loop disables a tool after a small number of failures. That guard is
 * necessary — without it a broken tool burns every iteration — but it is only
 * correct if "failure" means "this tool cannot work right now", not "the model
 * passed the wrong argument and has been told the right one".
 *
 * Getting this wrong is worse than having no cap at all, because the model is
 * punished precisely when it starts behaving. Real sequence from the traces:
 *
 *   ha_get_state("climate.mini_split")
 *     -> Entity doesn't exist. Real climate entities on THIS system: <lists them>
 *   ha_get_state("climate.house_mini_split_mini_split")   <- model obeyed
 *     -> "has been disabled for this request because it failed repeatedly"
 *
 * The cause was a reworded message: c337d25 changed "does not exist" to the
 * contraction "doesn't exist", which silently fell out of the recoverable
 * regex. Extracted here so the patterns are named, unit-tested against
 * verbatim production error strings, and hard to break by accident.
 */

export type ToolErrorClass =
  | 'config'
  | 'param'
  | 'gpu_busy'
  | 'no_data'
  | 'path'
  | 'other';

/** Config/auth problems the model cannot fix by retrying. Block immediately. */
export const CONFIG_ERROR =
  /not configured|api key|unauthorized|forbidden|invalid.*(?:model|endpoint|key)|ECONNREFUSED/i;

/** Missing/!malformed arguments — the model can fix these on the next call. */
export const PARAM_ERROR =
  /missing required parameter|is required|must provide|please provide/i;

/** Home Assistant 400/422 = argument shape problem, not a broken tool. */
export const HA_SHAPE_ERROR = /HA API (?:400|422)\b/i;

/** Hallucinated HA domain/service/entity — recoverable via discovery. */
export const HA_DISCOVERY_ERROR =
  /invented this domain|does not exist on this Home Assistant|HA API 404: Entity not found/i;

export const GPU_BUSY = /GPU is busy|GPU is currently busy/i;

/** "No history/data/results for X" is informational — the tool worked. */
export const NO_DATA = /no (?:history |data |results? )(?:data |found )?for /i;

/**
 * File/path misses.
 *
 * Matches "does not exist" AND the contraction "doesn't exist" with straight
 * ('), curly (’) or absent apostrophes. Do not narrow this without updating
 * __tests__/recoverable-error-classification.test.ts.
 */
export const PATH_ERROR =
  /ENOENT|no such file or directory|file not found|path not found|does\s?n[o']?t exist|doesn[’']t exist|does not exist|not found in project/i;

/**
 * A reference (image id, entity id, camera, service) that does not exist AND
 * where the error text already contains the valid alternatives. These are the
 * most recoverable errors the system produces — the answer is in the message —
 * so they must never count toward the failure cap.
 */
export const STALE_REF_ERROR = new RegExp(
  [
    // Image / generic ids
    /\bid ".*?" (?:was|is) not found/.source,
    /image id .*? (?:was|is) not found/.source,
    /no .*? with id ["']/.source,
    // Home Assistant discovery errors that enumerate the real ids
    /Real \w[\w ]*? (?:entities|services)[^\n]*?on THIS system/.source,
    /Cameras on THIS system/.source,
    /Real services in/.source,
    /No camera matches/.source,
  ].join('|'),
  'i',
);

/** Folder-ownership / shared-folder blocks — argument-specific, recoverable. */
export const PERMISSION_BLOCK =
  /^Blocked: (?:cannot (?:write into|delete from) another Choom|sibling_journal\/ is archived|[^/]+\/ is a shared folder)/i;

export interface ToolErrorVerdict {
  errorClass: ToolErrorClass;
  /** True when the error must NOT count toward the per-tool failure cap. */
  recoverable: boolean;
  /** True when the tool should be blocked immediately (model cannot fix it). */
  blockImmediately: boolean;
}

export function classifyToolError(toolName: string, error: string): ToolErrorVerdict {
  const isConfig = CONFIG_ERROR.test(error);
  const isHaShape = toolName === 'ha_call_service' && HA_SHAPE_ERROR.test(error);
  const isHaDiscovery =
    /^ha_(?:call_service|get_state)$/.test(toolName) && HA_DISCOVERY_ERROR.test(error);
  const isParam = PARAM_ERROR.test(error) || isHaShape || isHaDiscovery;
  const isGpuBusy = GPU_BUSY.test(error);
  const isNoData = NO_DATA.test(error);
  const isPath = PATH_ERROR.test(error);
  const isStaleRef = STALE_REF_ERROR.test(error);
  const isPermissionBlock = PERMISSION_BLOCK.test(error);

  const errorClass: ToolErrorClass = isConfig
    ? 'config'
    : isParam
      ? 'param'
      : isGpuBusy
        ? 'gpu_busy'
        : isNoData
          ? 'no_data'
          : isPath || isPermissionBlock || isStaleRef
            ? 'path'
            : 'other';

  return {
    errorClass,
    recoverable: isPath || isStaleRef || isPermissionBlock || isNoData || isParam,
    blockImmediately: isConfig,
  };
}
