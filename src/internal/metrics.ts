import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowRunMetrics, WorkflowRunStatus, WorkflowStageMetrics, WorkflowUsage } from "../api.ts";
import { workflowRunCurrentRoot } from "./run-store.ts";
import { RUNTIME_STATE_FILE_NAME } from "./runtime-state.ts";
import { addWorkflowUsage, emptyWorkflowUsage, workflowUsageFromValue } from "./usage.ts";

type WorkflowRunManifestEvent = Record<string, unknown> & {
	readonly at?: string;
	readonly type?: string;
};

type WorkflowRunManifest = {
	readonly events?: readonly WorkflowRunManifestEvent[];
};

type WorkflowRuntimeStateSnapshot = {
	readonly status?: WorkflowRunStatus;
	readonly startedAt?: string;
	readonly updatedAt?: string;
	readonly outcome?: { readonly completedAt?: string } | null;
	readonly failed?: { readonly failedAt?: string } | null;
};

type OpenWorkflowStageMetrics = Omit<WorkflowStageMetrics, "index" | "status" | "endedAt" | "wallMs" | "codeMs"> & {
	readonly startedAtMs: number;
};

export async function readWorkflowRunMetrics(runRoot: string): Promise<WorkflowRunMetrics> {
	const currentRoot = workflowRunCurrentRoot(runRoot);
	const [state, events] = await Promise.all([
		readRuntimeStateSnapshot(join(currentRoot, RUNTIME_STATE_FILE_NAME)),
		readManifestEvents(join(currentRoot, "manifest.json")),
	]);
	return calculateWorkflowRunMetrics(events, state, new Date());
}

export function calculateWorkflowRunMetrics(
	events: readonly WorkflowRunManifestEvent[],
	state: WorkflowRuntimeStateSnapshot,
	now: Date,
): WorkflowRunMetrics {
	const startedAt = state.startedAt ?? firstEventTime(events) ?? now.toISOString();
	const endedAt = runEndedAt(state);
	const startedAtMs = timestampMs(startedAt) ?? now.getTime();
	const endedAtMs = timestampMs(endedAt) ?? now.getTime();
	const stages: WorkflowStageMetrics[] = [];
	let openStage: OpenWorkflowStageMetrics | undefined;
	let gateStartedAtMs: number | undefined;
	let gateWaitMs = 0;
	let agentMs = 0;
	let commandMs = 0;
	let usage = emptyWorkflowUsage();

	for (const event of events) {
		const eventAtMs = timestampMs(event.at);
		if (event.type === "run.interrupted" && eventAtMs !== undefined) gateStartedAtMs = eventAtMs;
		else if (event.type === "run.resumed" && eventAtMs !== undefined && gateStartedAtMs !== undefined) {
			gateWaitMs += Math.max(0, eventAtMs - gateStartedAtMs);
			gateStartedAtMs = undefined;
		}

		if (event.type === "workflow.started") {
			openStage = {
				workflowId: stringField(event.workflowId, "unknown"),
				startedAt: isoTime(event.at, now),
				startedAtMs: eventAtMs ?? now.getTime(),
				agentMs: 0,
				commandMs: 0,
				usage: emptyWorkflowUsage(),
			};
			continue;
		}

		if (event.type === "agent.completed" || event.type === "agent.failed") {
			const durationMs = numberField(event.durationMs);
			const eventUsage = usageFromEvent(event);
			agentMs += durationMs;
			usage = addWorkflowUsage(usage, eventUsage);
			if (openStage) openStage = { ...openStage, agentMs: openStage.agentMs + durationMs, usage: addWorkflowUsage(openStage.usage, eventUsage) };
			continue;
		}

		if (event.type === "command.completed" || event.type === "command.failed") {
			const durationMs = numberField(event.durationMs);
			commandMs += durationMs;
			if (openStage) openStage = { ...openStage, commandMs: openStage.commandMs + durationMs };
			continue;
		}

		const status = workflowTerminalStatus(event.type);
		if (status) {
			const durationMs = numberField(event.durationMs) || (openStage && eventAtMs !== undefined ? Math.max(0, eventAtMs - openStage.startedAtMs) : 0);
			const workflowId = status === "transitioned" ? stringField(event.fromWorkflowId, openStage?.workflowId ?? "unknown") : stringField(event.workflowId, openStage?.workflowId ?? "unknown");
			const stage = openStage ?? {
				workflowId,
				startedAt: isoTimeFromMs(eventAtMs === undefined ? endedAtMs : Math.max(startedAtMs, eventAtMs - durationMs)),
				startedAtMs: eventAtMs === undefined ? endedAtMs : Math.max(startedAtMs, eventAtMs - durationMs),
				agentMs: 0,
				commandMs: 0,
				usage: emptyWorkflowUsage(),
			};
			stages.push(closeStage(stage, stages.length + 1, status, durationMs, event.at));
			openStage = undefined;
		}
	}

	if (gateStartedAtMs !== undefined) gateWaitMs += Math.max(0, endedAtMs - gateStartedAtMs);
	if (openStage) stages.push(closeStage(openStage, stages.length + 1, "running", Math.max(0, endedAtMs - openStage.startedAtMs), endedAt));
	const workflowMs = stages.reduce((sum, stage) => sum + stage.wallMs, 0);
	const wallMs = Math.max(0, endedAtMs - startedAtMs);
	return {
		status: state.status ?? "running",
		startedAt,
		...(endedAt === undefined ? {} : { endedAt }),
		wallMs,
		activeMs: Math.max(0, wallMs - gateWaitMs),
		gateWaitMs,
		workflowMs,
		agentMs,
		commandMs,
		codeMs: Math.max(0, workflowMs - agentMs - commandMs),
		usage,
		stages,
	};
}

async function readRuntimeStateSnapshot(path: string): Promise<WorkflowRuntimeStateSnapshot> {
	return JSON.parse(await readFile(path, "utf8")) as WorkflowRuntimeStateSnapshot;
}

async function readManifestEvents(path: string): Promise<readonly WorkflowRunManifestEvent[]> {
	const manifest = JSON.parse(await readFile(path, "utf8")) as WorkflowRunManifest;
	return manifest.events ?? [];
}

function closeStage(
	stage: OpenWorkflowStageMetrics,
	index: number,
	status: WorkflowStageMetrics["status"],
	wallMs: number,
	endedAt: string | undefined,
): WorkflowStageMetrics {
	return {
		index,
		workflowId: stage.workflowId,
		status,
		startedAt: stage.startedAt,
		...(endedAt === undefined ? {} : { endedAt }),
		wallMs,
		agentMs: stage.agentMs,
		commandMs: stage.commandMs,
		codeMs: Math.max(0, wallMs - stage.agentMs - stage.commandMs),
		usage: stage.usage,
	};
}

function workflowTerminalStatus(type: unknown): WorkflowStageMetrics["status"] | undefined {
	if (type === "workflow.completed") return "completed";
	if (type === "workflow.failed") return "failed";
	if (type === "workflow.transitioned") return "transitioned";
	return undefined;
}

function runEndedAt(state: WorkflowRuntimeStateSnapshot): string | undefined {
	if (state.status === "completed") return state.outcome?.completedAt ?? state.updatedAt;
	if (state.status === "failed") return state.failed?.failedAt ?? state.outcome?.completedAt ?? state.updatedAt;
	return undefined;
}

function usageFromEvent(event: WorkflowRunManifestEvent): WorkflowUsage {
	return workflowUsageFromValue(event.usage) ?? emptyWorkflowUsage();
}

function firstEventTime(events: readonly WorkflowRunManifestEvent[]): string | undefined {
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

function stringField(value: unknown, fallback: string): string {
	return typeof value === "string" && value.length > 0 ? value : fallback;
}
