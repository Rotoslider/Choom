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
  | 'auth'
  | 'param'
  | 'gpu_busy'
  | 'no_data'
  | 'path'
  | 'permission_block'
  | 'rate_limit'
  | 'timeout'
  | 'network'
  | 'upstream_4xx'
  | 'upstream_5xx'
  | 'template'
  | 'blocked_reissue'
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

/** Permission-policy blocks — argument-specific and recoverable. */
export const PERMISSION_BLOCK =
  /^Blocked: (?:cannot (?:write into|delete from) another Choom|sibling_journal\/ is archived|[^/]+\/ is a shared folder|remote SSH is disabled|direct SSH shell commands are disabled)/i;

/**
 * Fine-grained classes below only refine the LABEL recorded in traces (what
 * the nightly doctor aggregates) — they deliberately do not change which
 * errors count toward the failure cap or block a tool. ~58% of all failures
 * were an unactionable "other" before these existed; every pattern is
 * validated against verbatim strings from data/traces (see the test file).
 */

/** Synthetic re-issue echoes: the loop already refused the call (disabled
 *  tool, repeat-call stop, cached failure). Model behavior, not tool health. */
export const BLOCKED_REISSUE =
  /has been disabled for this request|\[This exact call already failed|^STOP\. You have already called/i;

/** Credentials rejected upstream: 401/403, expired/invalid keys or tokens. */
export const AUTH_ERROR =
  /\b40[13]\b|unauthorized|forbidden|api key|invalid.*(?:token|credential)|insufficient authentication|authentication (?:failed|required)/i;

export const RATE_LIMIT =
  /\b429\b|rate.?limit|too many requests|quota exceeded|resource.?exhausted/i;

export const TIMEOUT_ERROR =
  /\btim(?:ed|e)[ -]?out\b|ETIMEDOUT|aborted due to timeout|deadline exceeded/i;

/** Transport never got a response: DNS/connect/reset, undici "fetch failed". */
export const NETWORK_ERROR =
  /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|could not connect|connection (?:refused|reset|closed|error)|network error|\bterminated\b/i;

export const UPSTREAM_5XX =
  /\b50[0-4]\b|internal server error|bad gateway|service unavailable|gateway time.?out/i;

/** Remaining upstream 4xx after auth/rate-limit/HA-shape have been peeled off
 *  (Weather 404, Gmail 400, Docs/Sheets 404, camera_proxy 404, Brave 422…).
 *  Numeric codes only — "Memory not found" is a stale ref, not an HTTP 404. */
export const UPSTREAM_4XX = /\b4\d\d\b/;

/** Strict chat-template crashes from the LLM wire format (the C-01 class):
 *  Qwen/ChatML Jinja raise_exception on mid-conversation system messages. */
export const TEMPLATE_ERROR =
  /system message must be at the beginning|raise_exception|conversation roles must alternate|only user and assistant roles|chat.?template|jinja/i;

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

  // Label precedence. The first tier preserves the original coarse classes
  // (config split into auth/network/config; permission blocks get their own
  // label so the doctor can report the contract gate WORKING instead of a 79%
  // "failure rate"). The second tier subdivides what used to be "other".
  const errorClass: ToolErrorClass = BLOCKED_REISSUE.test(error)
    ? 'blocked_reissue'
    : isConfig || AUTH_ERROR.test(error)
      ? (AUTH_ERROR.test(error) ? 'auth' : /ECONNREFUSED/i.test(error) ? 'network' : 'config')
      : isParam
        ? 'param'
        : isGpuBusy
          ? 'gpu_busy'
          : isNoData
            ? 'no_data'
            : isPermissionBlock
              ? 'permission_block'
              : isPath || isStaleRef
                ? 'path'
                : RATE_LIMIT.test(error)
                  ? 'rate_limit'
                  : TEMPLATE_ERROR.test(error)
                    ? 'template'
                    : TIMEOUT_ERROR.test(error)
                      ? 'timeout'
                      // Status codes BEFORE transport patterns: tool wrappers
                      // like "Weather fetch failed: Weather API error: 404"
                      // contain "fetch failed" as prose — when an upstream
                      // status is present, IT is the actual cause. Bare
                      // "fetch failed" (undici, no status) stays network.
                      : UPSTREAM_5XX.test(error)
                        ? 'upstream_5xx'
                        : UPSTREAM_4XX.test(error)
                          ? 'upstream_4xx'
                          : NETWORK_ERROR.test(error)
                            ? 'network'
                            : 'other';

  return {
    errorClass,
    // Cap/blocking behavior is unchanged by the fine-grained labels: recoverable
    // and blockImmediately still key off the ORIGINAL coarse pattern sets, so an
    // error that used to count toward the cap still does under its new name.
    recoverable: isPath || isStaleRef || isPermissionBlock || isNoData || isParam,
    blockImmediately: isConfig,
  };
}
