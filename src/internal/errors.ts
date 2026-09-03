export class NornRunStoppedError extends Error {
	constructor() {
		super("Stopped by user");
		this.name = "NornRunStoppedError";
	}
}

export function zodErrorMessage(error: unknown): string {
	const issues = (error as { issues?: Array<{ path?: unknown[]; message?: string }> }).issues;
	if (!Array.isArray(issues) || issues.length === 0) return errorMessage(error);
	return issues
		.slice(0, 3)
		.map((issue) => {
			const path = Array.isArray(issue.path) && issue.path.length > 0 ? `${issue.path.join(".")}: ` : "";
			return `${path}${issue.message ?? "Invalid workflow response"}`;
		})
		.join("; ");
}

export function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function isNodeError(error: unknown): error is NodeJS.ErrnoException {
	return error instanceof Error && "code" in error;
}
