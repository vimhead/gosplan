import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PalantirAgentMetrics, PalantirAgentUsage, PalantirCommandMetrics, PalantirRunMetrics, PalantirRunStatus, PalantirWorkflowMetrics } from "../api.ts";
import { runCurrentRoot } from "./run-store.ts";
import { RUN_STATE_FILE_NAME } from "./run-state.ts";
import { isNodeError } from "./errors.ts";
import { addAgentUsage, agentUsageFromValue, emptyAgentUsage } from "./usage.ts";

const LEGACY_RUN_STATE_FILE_NAME = "runtime-state.json";

type PalantirRunManifestEvent = Record<string, unknown> & {
	readonly at?: string;
	readonly type?: string;
};

type PalantirRunManifest = {
	readonly events?: readonly PalantirRunManifestEvent[];
};

type PalantirRunStateSnapshot = {
	readonly status?: PalantirRunStatus;
	readonly startedAt?: string;
	readonly updatedAt?: string;
	readonly outcome?: { readonly completedAt?: string } | null;
	readonly failed?: { readonly failedAt?: string } | null;
};

type OpenWorkflowMetrics = {
	readonly workflowId: string;
	readonly startedAt: string;
	readonly startedAtMs: number;
	readonly agents: readonly PalantirAgentMetrics[];
	readonly commands: readonly PalantirCommandMetrics[];
	readonly openAgents: readonly OpenAgentMetrics[];
	readonly openCommands: readonly OpenCommandMetrics[];
};

type OpenAgentMetrics = {
	readonly label: string;
	readonly startedAt: string;
	readonly startedAtMs: number;
};

type OpenCommandMetrics = {
	readonly label: string;
	readonly startedAt: string;
	readonly startedAtMs: number;
};

export async function readRunMetrics(runRoot: string): Promise<PalantirRunMetrics> {
	const currentRoot = runCurrentRoot(runRoot);
	const [state, events] = await Promise.all([
		readRunStateSnapshot(currentRoot),
		readManifestEvents(join(currentRoot, "manifest.json")),
	]);
	return calculateRunMetrics(events, state, new Date());
}

export function calculateRunMetrics(
	events: readonly PalantirRunManifestEvent[],
	state: PalantirRunStateSnapshot,
	now: Date,
): PalantirRunMetrics {
	const startedAt = state.startedAt ?? firstEventTime(events) ?? now.toISOString();
	const endedAt = runEndedAt(state);
	const startedAtMs = timestampMs(startedAt) ?? now.getTime();
	const endedAtMs = timestampMs(endedAt) ?? now.getTime();
	const workflows: PalantirWorkflowMetrics[] = [];
	let openWorkflow: OpenWorkflowMetrics | undefined;
	let gateStartedAtMs: number | undefined;
	let gateWaitMs = 0;
	let agentUsage = emptyAgentUsage();

	for (const event of events) {
		const eventAtMs = timestampMs(event.at);
		if (event.type === "run.interrupted" && eventAtMs !== undefined) gateStartedAtMs = eventAtMs;
		else if (event.type === "run.resumed" && eventAtMs !== undefined && gateStartedAtMs !== undefined) {
			gateWaitMs += Math.max(0, eventAtMs - gateStartedAtMs);
			gateStartedAtMs = undefined;
		}

		if (event.type === "workflow.started") {
			openWorkflow = {
				workflowId: stringField(event.workflowId, "unknown"),
				startedAt: isoTime(event.at, now),
				startedAtMs: eventAtMs ?? now.getTime(),
				agents: [],
				commands: [],
				openAgents: [],
				openCommands: [],
			};
			continue;
		}

		if (event.type === "agent.started") {
			if (openWorkflow) openWorkflow = startAgentMetrics(openWorkflow, event, now);
			continue;
		}

		if (event.type === "agent.completed" || event.type === "agent.failed") {
			const usage = agentUsageFromEvent(event);
			agentUsage = addAgentUsage(agentUsage, usage);
			if (openWorkflow) openWorkflow = finishAgentMetrics(openWorkflow, event, usage, now);
			continue;
		}

		if (event.type === "command.started") {
			if (openWorkflow) openWorkflow = startCommandMetrics(openWorkflow, event, now);
			continue;
		}

		if (event.type === "command.completed" || event.type === "command.failed") {
			if (openWorkflow) openWorkflow = finishCommandMetrics(openWorkflow, event, now);
			continue;
		}

		const status = workflowTerminalStatus(event.type);
		if (status) {
			const durationMs = numberField(event.durationMs) || (openWorkflow && eventAtMs !== undefined ? Math.max(0, eventAtMs - openWorkflow.startedAtMs) : 0);
			const workflowId = status === "transitioned" ? stringField(event.fromWorkflowId, openWorkflow?.workflowId ?? "unknown") : stringField(event.workflowId, openWorkflow?.workflowId ?? "unknown");
			const workflow = openWorkflow ?? createSyntheticWorkflowMetrics(workflowId, startedAtMs, endedAtMs, eventAtMs, durationMs);
			const childStatus = status === "failed" ? "failed" : "completed";
			workflows.push(closeWorkflowMetrics(closeOpenChildMetrics(workflow, eventAtMs ?? now.getTime(), event.at, childStatus), workflows.length + 1, status, durationMs, event.at));
			openWorkflow = undefined;
		}
	}

	if (gateStartedAtMs !== undefined) gateWaitMs += Math.max(0, endedAtMs - gateStartedAtMs);
	if (openWorkflow) {
		workflows.push(closeWorkflowMetrics(closeOpenChildMetrics(openWorkflow, endedAtMs, endedAt, "running"), workflows.length + 1, "running", Math.max(0, endedAtMs - openWorkflow.startedAtMs), endedAt));
	}
	const workflowsMs = workflows.reduce((sum, workflow) => sum + workflow.wallMs, 0);
	const agentsMs = workflows.reduce((sum, workflow) => sum + workflow.agentsMs, 0);
	const commandsMs = workflows.reduce((sum, workflow) => sum + workflow.commandsMs, 0);
	const wallMs = Math.max(0, endedAtMs - startedAtMs);
	return {
		status: state.status ?? "running",
		startedAt,
		...(endedAt === undefined ? {} : { endedAt }),
		wallMs,
		activeMs: Math.max(0, wallMs - gateWaitMs),
		gateWaitMs,
		workflowsMs,
		workflowOwnMs: Math.max(0, workflowsMs - agentsMs - commandsMs),
		agentsMs,
		commandsMs,
		agentUsage,
		workflows,
	};
}

async function readRunStateSnapshot(currentRoot: string): Promise<PalantirRunStateSnapshot> {
	try {
		return JSON.parse(await readFile(join(currentRoot, RUN_STATE_FILE_NAME), "utf8")) as PalantirRunStateSnapshot;
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return JSON.parse(await readFile(join(currentRoot, LEGACY_RUN_STATE_FILE_NAME), "utf8")) as PalantirRunStateSnapshot;
	}
}

async function readManifestEvents(path: string): Promise<readonly PalantirRunManifestEvent[]> {
	const manifest = JSON.parse(await readFile(path, "utf8")) as PalantirRunManifest;
	return manifest.events ?? [];
}

function createSyntheticWorkflowMetrics(workflowId: string, runStartedAtMs: number, runEndedAtMs: number, eventAtMs: number | undefined, durationMs: number): OpenWorkflowMetrics {
	const startedAtMs = eventAtMs === undefined ? runEndedAtMs : Math.max(runStartedAtMs, eventAtMs - durationMs);
	return {
		workflowId,
		startedAt: isoTimeFromMs(startedAtMs),
		startedAtMs,
		agents: [],
		commands: [],
		openAgents: [],
		openCommands: [],
	};
}

function startAgentMetrics(workflow: OpenWorkflowMetrics, event: PalantirRunManifestEvent, now: Date): OpenWorkflowMetrics {
	return {
		...workflow,
		openAgents: [...workflow.openAgents, {
			label: stringField(event.label, "unknown"),
			startedAt: isoTime(event.at, now),
			startedAtMs: timestampMs(event.at) ?? now.getTime(),
		}],
	};
}

function finishAgentMetrics(workflow: OpenWorkflowMetrics, event: PalantirRunManifestEvent, usage: PalantirAgentUsage, now: Date): OpenWorkflowMetrics {
	const [agent, openAgents] = takeOpenChild(workflow.openAgents, stringField(event.label, "unknown"));
	const closedAgent = closeAgentMetrics(event, workflow.agents.length + 1, usage, now, agent);
	return { ...workflow, agents: [...workflow.agents, closedAgent], openAgents };
}

function startCommandMetrics(workflow: OpenWorkflowMetrics, event: PalantirRunManifestEvent, now: Date): OpenWorkflowMetrics {
	return {
		...workflow,
		openCommands: [...workflow.openCommands, {
			label: stringField(event.label, "unknown"),
			startedAt: isoTime(event.at, now),
			startedAtMs: timestampMs(event.at) ?? now.getTime(),
		}],
	};
}

function finishCommandMetrics(workflow: OpenWorkflowMetrics, event: PalantirRunManifestEvent, now: Date): OpenWorkflowMetrics {
	const [command, openCommands] = takeOpenChild(workflow.openCommands, stringField(event.label, "unknown"));
	const closedCommand = closeCommandMetrics(event, workflow.commands.length + 1, now, command);
	return { ...workflow, commands: [...workflow.commands, closedCommand], openCommands };
}

function closeOpenChildMetrics(workflow: OpenWorkflowMetrics, endedAtMs: number, endedAt: string | undefined, status: PalantirAgentMetrics["status"]): OpenWorkflowMetrics {
	return {
		...workflow,
		agents: [
			...workflow.agents,
			...workflow.openAgents.map((agent, offset): PalantirAgentMetrics => ({
				index: workflow.agents.length + offset + 1,
				label: agent.label,
				status,
				startedAt: agent.startedAt,
				...(endedAt === undefined ? {} : { endedAt }),
				wallMs: Math.max(0, endedAtMs - agent.startedAtMs),
				usage: emptyAgentUsage(),
			})),
		],
		commands: [
			...workflow.commands,
			...workflow.openCommands.map((command, offset): PalantirCommandMetrics => ({
				index: workflow.commands.length + offset + 1,
				label: command.label,
				status,
				startedAt: command.startedAt,
				...(endedAt === undefined ? {} : { endedAt }),
				wallMs: Math.max(0, endedAtMs - command.startedAtMs),
			})),
		],
		openAgents: [],
		openCommands: [],
	};
}

function closeWorkflowMetrics(
	workflow: OpenWorkflowMetrics,
	index: number,
	status: PalantirWorkflowMetrics["status"],
	wallMs: number,
	endedAt: string | undefined,
): PalantirWorkflowMetrics {
	const agentsMs = workflow.agents.reduce((sum, agent) => sum + agent.wallMs, 0);
	const commandsMs = workflow.commands.reduce((sum, command) => sum + command.wallMs, 0);
	return {
		index,
		workflowId: workflow.workflowId,
		status,
		startedAt: workflow.startedAt,
		...(endedAt === undefined ? {} : { endedAt }),
		wallMs,
		ownMs: Math.max(0, wallMs - agentsMs - commandsMs),
		agentsMs,
		commandsMs,
		agentUsage: workflow.agents.reduce((sum, agent) => addAgentUsage(sum, agent.usage), emptyAgentUsage()),
		agents: workflow.agents,
		commands: workflow.commands,
	};
}

function closeAgentMetrics(event: PalantirRunManifestEvent, index: number, usage: PalantirAgentUsage, now: Date, openAgent: OpenAgentMetrics | undefined): PalantirAgentMetrics {
	const endedAtMs = timestampMs(event.at) ?? now.getTime();
	const wallMs = numberField(event.durationMs) || (openAgent ? Math.max(0, endedAtMs - openAgent.startedAtMs) : 0);
	return {
		index,
		label: stringField(event.label, openAgent?.label ?? "unknown"),
		status: event.type === "agent.failed" ? "failed" : "completed",
		startedAt: openAgent?.startedAt ?? isoTimeFromMs(Math.max(0, endedAtMs - wallMs)),
		endedAt: isoTime(event.at, now),
		wallMs,
		attempts: optionalNumberField(event.attempts),
		usage,
	};
}

function closeCommandMetrics(event: PalantirRunManifestEvent, index: number, now: Date, openCommand: OpenCommandMetrics | undefined): PalantirCommandMetrics {
	const endedAtMs = timestampMs(event.at) ?? now.getTime();
	const wallMs = numberField(event.durationMs) || (openCommand ? Math.max(0, endedAtMs - openCommand.startedAtMs) : 0);
	return {
		index,
		label: stringField(event.label, openCommand?.label ?? "unknown"),
		status: event.type === "command.failed" ? "failed" : "completed",
		startedAt: openCommand?.startedAt ?? isoTimeFromMs(Math.max(0, endedAtMs - wallMs)),
		endedAt: isoTime(event.at, now),
		wallMs,
		...(event.type === "command.completed" ? { exitCode: nullableNumberField(event.exitCode), killed: booleanField(event.killed) } : {}),
	};
}

function takeOpenChild<T extends { readonly label: string }>(children: readonly T[], label: string): readonly [T | undefined, readonly T[]] {
	const index = children.findIndex((child) => child.label === label);
	if (index === -1) return [undefined, children];
	return [children[index], [...children.slice(0, index), ...children.slice(index + 1)]];
}

function workflowTerminalStatus(type: unknown): PalantirWorkflowMetrics["status"] | undefined {
	if (type === "workflow.completed") return "completed";
	if (type === "workflow.failed") return "failed";
	if (type === "workflow.transitioned") return "transitioned";
	return undefined;
}

function runEndedAt(state: PalantirRunStateSnapshot): string | undefined {
	if (state.status === "completed") return state.outcome?.completedAt ?? state.updatedAt;
	if (state.status === "failed") return state.failed?.failedAt ?? state.outcome?.completedAt ?? state.updatedAt;
	return undefined;
}

function agentUsageFromEvent(event: PalantirRunManifestEvent): PalantirAgentUsage {
	return agentUsageFromValue(event.usage) ?? emptyAgentUsage();
}

function firstEventTime(events: readonly PalantirRunManifestEvent[]): string | undefined {
	return events.find((event) => timestampMs(event.at) !== undefined)?.at;
}

function timestampMs(value: string | undefined): number | undefined {
	const parsed = value ? Date.parse(value) : NaN;
	return Number.isFinite(parsed) ? parsed : undefined;
}

function isoTime(value: string | undefined, now: Date): string {
	return value && timestampMs(value) !== undefined ? value : now.toISOString();
}

function isoTimeFromMs(value: number): string {
	return new Date(value).toISOString();
}

function numberField(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function optionalNumberField(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function nullableNumberField(value: unknown): number | null {
	return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function booleanField(value: unknown): boolean {
	return typeof value === "boolean" ? value : false;
}

function stringField(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}
