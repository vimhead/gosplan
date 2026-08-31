import type { AgentUsage } from "../api.ts";

export function agentUsageFromValue(value: unknown): AgentUsage | undefined {
	if (!value || typeof value !== "object") return undefined;
	const usage = value as Record<string, unknown>;
	const input = numberField(usage.input);
	const output = numberField(usage.output);
	const cacheRead = numberField(usage.cacheRead);
	const cacheWrite = numberField(usage.cacheWrite);
	const reasoning = optionalNumberField(usage.reasoning);
	const totalTokens = numberField(usage.totalTokens) || input + output + cacheRead + cacheWrite;
	const costValue = usage.cost && typeof usage.cost === "object" ? usage.cost as Record<string, unknown> : {};
	return {
		input,
		output,
		cacheRead,
		cacheWrite,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens,
		cost: {
			input: numberField(costValue.input),
			output: numberField(costValue.output),
			cacheRead: numberField(costValue.cacheRead),
			cacheWrite: numberField(costValue.cacheWrite),
			total: numberField(costValue.total),
		},
	};
}

export function totalAgentUsage(usages: readonly AgentUsage[]): AgentUsage {
	return usages.reduce(addAgentUsage, emptyAgentUsage());
}

export function addAgentUsage(left: AgentUsage, right: AgentUsage): AgentUsage {
	const reasoning = left.reasoning === undefined && right.reasoning === undefined ? undefined : (left.reasoning ?? 0) + (right.reasoning ?? 0);
	return {
		input: left.input + right.input,
		output: left.output + right.output,
		cacheRead: left.cacheRead + right.cacheRead,
		cacheWrite: left.cacheWrite + right.cacheWrite,
		...(reasoning === undefined ? {} : { reasoning }),
		totalTokens: left.totalTokens + right.totalTokens,
		cost: {
			input: left.cost.input + right.cost.input,
			output: left.cost.output + right.cost.output,
			cacheRead: left.cost.cacheRead + right.cost.cacheRead,
			cacheWrite: left.cost.cacheWrite + right.cost.cacheWrite,
			total: left.cost.total + right.cost.total,
		},
	};
}

export function emptyAgentUsage(): AgentUsage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}
