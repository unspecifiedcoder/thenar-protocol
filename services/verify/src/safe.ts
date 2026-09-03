/**
 * Safe wrapper for check functions (T-031, T-020).
 *
 * Wraps a check function so that if it throws, the result is
 * `inconclusive` with the error recorded in `detail.error`.
 * This ensures a check function exception doesn't crash the pipeline.
 */

export type CheckResult = "pass" | "fail" | "inconclusive";

export type CheckDetail = {
  error?: string;
  check_version?: string;
  thresholds?: Record<string, any>;
  [key: string]: any;
};

/**
 * Safely run a check function that might throw.
 * If the check throws, return inconclusive with the error in detail.
 *
 * @param check The check function to run
 * @returns A tuple of [result, detail]
 */
export async function safeRun(
  check: () => Promise<{ result: CheckResult; detail: CheckDetail }>,
): Promise<{ result: CheckResult; detail: CheckDetail }> {
  try {
    return await check();
  } catch (err) {
    const errorMsg = err instanceof Error ? err.message : String(err);
    return {
      result: "inconclusive",
      detail: {
        error: errorMsg,
      },
    };
  }
}
