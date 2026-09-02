import type { NornCommandRunResult } from "norn";

export async function ensureCommandSucceeded(result: NornCommandRunResult): Promise<void> {
	if (result.exitCode === 0) return;
	throw new Error(`${result.label} failed with exit code ${result.exitCode ?? "unknown"}: ${result.stderrTail || result.stdoutTail}`);
}
