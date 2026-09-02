import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { NornRunHealth, NornRunStatus, NornRunOutcomeMetadata, NornRunInfo, NornRunInterruption, NornRunOutcomeInfo, NornRunFailureInfo } from "../api.ts";
import { isNodeError } from "./errors.ts";
import { readRunLaunchRequest } from "./launch-request.ts";
import { getRunLeaseHealth } from "./run-lease.ts";
import { writeJsonAtomically } from "./json-file.ts";
import { runCurrentRoot } from "./run-store.ts";

export const RUN_STATE_FILE_NAME = "run-state.json";
const LEGACY_RUN_STATE_FILE_NAME = "runtime-state.json";
const RUN_STATE_VERSION = 1;

type NornRunWorkflowStep = {
	readonly workflowId: string;
	readonly params: unknown;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly interruption?: RuntimeInterruption;
};

type RuntimeInterruption = {
	readonly status: "pending" | "satisfied";
	readonly description?: string;
	readonly fields?: readonly string[];
};

type NornRunWorkflowCompletion = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly outcome: { readonly type: "next"; readonly workflowId: string } | { readonly type: "complete" } | { readonly type: "fail" };
};

type NornRunWorkflowFailure = {
	readonly workflowId: string;
	readonly error: string;
	readonly metadata?: NornRunOutcomeMetadata;
	readonly failedAt: string;
};

type NornRunWorkflowOutcome = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly status: "completed" | "failed";
	readonly metadata?: NornRunOutcomeMetadata;
};

export type NornRunState = {
	readonly version: typeof RUN_STATE_VERSION;
	readonly id: string;
	readonly name: string;
	readonly entrypointWorkflowId: string;
	readonly workspace: string;
	readonly configOverride?: unknown;
	readonly status: NornRunStatus;
	readonly current: NornRunWorkflowStep | null;
	readonly lastCompleted: NornRunWorkflowCompletion | null;
	readonly outcome: NornRunWorkflowOutcome | null;
	readonly failed: NornRunWorkflowFailure | null;
	readonly startedAt: string;
	readonly updatedAt: string;
};

type CreateNornRunStateInput = {
	readonly id: string;
	readonly name: string;
	readonly entrypointWorkflowId: string;
	readonly workspace: string;
	readonly configOverride?: unknown;
	readonly current: NornRunWorkflowStep;
	readonly startedAt: string;
};

export class NornRunStateStore {
	private writeChain: Promise<void> = Promise.resolve();

	private constructor(
		private readonly path: string,
		private state: NornRunState,
	) {}

	static async create(runRoot: string, input: CreateNornRunStateInput): Promise<NornRunStateStore> {
		const now = input.startedAt;
		const state: NornRunState = {
			version: RUN_STATE_VERSION,
			id: input.id,
			name: input.name,
			entrypointWorkflowId: input.entrypointWorkflowId,
			workspace: input.workspace,
			configOverride: input.configOverride,
			status: "running",
			current: input.current,
			lastCompleted: null,
			outcome: null,
			failed: null,
			startedAt: now,
			updatedAt: now,
		};
		const store = new NornRunStateStore(join(runCurrentRoot(runRoot), RUN_STATE_FILE_NAME), state);
		await store.write();
		return store;
	}

	static async load(runRoot: string): Promise<NornRunStateStore> {
		const currentRoot = runCurrentRoot(runRoot);
		const state = parseNornRunState(await readRunStateJson(currentRoot));
		return new NornRunStateStore(join(currentRoot, RUN_STATE_FILE_NAME), state);
	}

	currentState(): NornRunState {
		return this.state;
	}

	async startStep(step: NornRunWorkflowStep): Promise<void> {
		await this.update({ status: "running", current: step, outcome: null, failed: null });
	}

	async completeWithNext(completedWorkflowId: string, next: NornRunWorkflowStep): Promise<void> {
		await this.update({
			status: "running",
			current: next,
			lastCompleted: { workflowId: completedWorkflowId, completedAt: new Date().toISOString(), outcome: { type: "next", workflowId: next.workflowId } },
			outcome: null,
			failed: null,
		});
	}

	async completeRun(workflowId: string, metadata: NornRunOutcomeMetadata | undefined): Promise<void> {
		const completedAt = new Date().toISOString();
		await this.update({
			status: "completed",
			current: null,
			lastCompleted: { workflowId, completedAt, outcome: { type: "complete" } },
			outcome: { workflowId, completedAt, status: "completed", metadata },
			failed: null,
		});
	}

	async failRun(workflowId: string, metadata: NornRunOutcomeMetadata & { readonly summary: string }): Promise<void> {
		const failedAt = new Date().toISOString();
		await this.update({
			status: "failed",
			current: null,
			lastCompleted: { workflowId, completedAt: failedAt, outcome: { type: "fail" } },
			outcome: { workflowId, completedAt: failedAt, status: "failed", metadata },
			failed: { workflowId, error: metadata.summary, metadata, failedAt },
		});
	}

	async interruptCurrent(params: unknown, interruption: { readonly description: string; readonly fields?: readonly string[] }): Promise<void> {
		if (!this.state.current) throw new Error("Cannot interrupt run without current step");
		await this.update({
			status: "interrupted",
			current: { ...this.state.current, params, interruption: { status: "pending", ...interruption } },
			outcome: null,
			failed: null,
		});
	}

	async replaceCurrentParams(params: unknown): Promise<void> {
		if (!this.state.current) throw new Error("Cannot resume run without current step");
		await this.update({
			status: "running",
			current: { ...this.state.current, params, interruption: { ...this.state.current.interruption, status: "satisfied" } },
			outcome: null,
			failed: null,
		});
	}

	async failCurrent(errorOrMetadata: string | NornRunOutcomeMetadata & { readonly summary: string }): Promise<void> {
		if (!this.state.current) throw new Error("Cannot fail run without current step");
		const failedAt = new Date().toISOString();
		const metadata = typeof errorOrMetadata === "string" ? { summary: errorOrMetadata } : errorOrMetadata;
		await this.update({
			status: "failed",
			outcome: { workflowId: this.state.current.workflowId, completedAt: failedAt, status: "failed", metadata },
			failed: { workflowId: this.state.current.workflowId, error: metadata.summary, metadata, failedAt },
		});
	}

	private async update(patch: Partial<NornRunState>): Promise<void> {
		this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
		await this.write();
	}

	private async write(): Promise<void> {
		this.writeChain = this.writeChain.then(() => writeJsonAtomically(this.path, this.state));
		await this.writeChain;
	}
}

export async function listRuns(sessionCwd: string): Promise<NornRunInfo[]> {
	const runsRoot = join(sessionCwd, ".norn", "runs");
	let entries;
	try {
		entries = await readdir(runsRoot, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}

	const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readNornRunInfo(resolve(runsRoot, entry.name))));
	return runs.filter((run): run is NornRunInfo => run !== undefined).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getRunInfo(runRoot: string): Promise<NornRunInfo> {
	try {
		const state = parseNornRunState(await readRunStateJson(runCurrentRoot(runRoot)));
		return {
			version: state.version,
			id: state.id,
			name: state.name,
			path: runRoot,
			entrypointWorkflowId: state.entrypointWorkflowId,
			currentWorkflowId: state.current?.workflowId,
			status: state.status,
			health: await runHealth(runRoot, state.status),
			interruption: runInterruption(state),
			outcome: runOutcome(state),
			failed: runFailure(state),
			startedAt: state.startedAt,
			updatedAt: state.updatedAt,
		};
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return getLaunchedRunInfo(runRoot);
	}
}

export async function resolveRunRoot(sessionCwd: string, run: string): Promise<string> {
	for (const candidate of runRootCandidates(sessionCwd, run)) {
		try {
			if (await readNornRunInfo(candidate)) return candidate;
		} catch (error) {
			if (!isNodeError(error) && (!(error instanceof Error) || !error.message.includes("run state"))) throw error;
		}
	}

	const runs = await listRuns(sessionCwd);
	const match = runs.find((entry) => entry.id === run || entry.name === run || entry.path === run || entry.path.endsWith(`/${run}`));
	if (!match) throw new Error(`Unknown run: ${run}`);
	return match.path;
}

function runRootCandidates(sessionCwd: string, run: string): string[] {
	const candidates = [isAbsolute(run) ? run : resolve(sessionCwd, run)];
	if (!isAbsolute(run)) candidates.push(resolve(sessionCwd, ".norn", "runs", run));
	return Array.from(new Set(candidates));
}

async function runHealth(runRoot: string, status: NornRunStatus): Promise<NornRunHealth> {
	if (status === "failed") return "unhealthy";
	if (status !== "running") return "healthy";
	return getRunLeaseHealth(runRoot);
}

async function readNornRunInfo(runRoot: string): Promise<NornRunInfo | undefined> {
	try {
		return await getRunInfo(runRoot);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function getLaunchedRunInfo(runRoot: string): Promise<NornRunInfo> {
	const launchRequest = await readRunLaunchRequest(runRoot);
	return {
		version: launchRequest.version,
		id: launchRequest.id,
		name: launchRequest.name,
		path: runRoot,
		entrypointWorkflowId: launchRequest.workflowId,
		currentWorkflowId: launchRequest.workflowId,
		status: "running",
		health: "healthy",
		startedAt: launchRequest.createdAt,
		updatedAt: launchRequest.createdAt,
	};
}

async function readRunStateJson(currentRoot: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(join(currentRoot, RUN_STATE_FILE_NAME), "utf8"));
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return JSON.parse(await readFile(join(currentRoot, LEGACY_RUN_STATE_FILE_NAME), "utf8"));
	}
}

function parseNornRunState(value: unknown): NornRunState {
	if (!value || typeof value !== "object") throw new Error("Invalid run state");
	const state = value as Partial<NornRunState> & { rootWorkflowId?: unknown };
	if (state.version !== RUN_STATE_VERSION) throw new Error(`Unsupported run state version: ${String(state.version)}`);
	if (typeof state.id !== "string" || state.id.length === 0) throw new Error("Invalid run state id");
	const normalizedState = state as { name?: string; entrypointWorkflowId?: unknown; rootWorkflowId?: unknown };
	if (typeof normalizedState.name !== "string" || normalizedState.name.length === 0) normalizedState.name = state.id;
	if (typeof normalizedState.entrypointWorkflowId !== "string" && typeof normalizedState.rootWorkflowId === "string") normalizedState.entrypointWorkflowId = normalizedState.rootWorkflowId;
	if (typeof state.entrypointWorkflowId !== "string" || state.entrypointWorkflowId.length === 0) throw new Error("Invalid run state entrypoint workflow id");
	if (typeof state.workspace !== "string" || state.workspace.length === 0) throw new Error("Invalid run state workspace");
	if (state.status !== "running" && state.status !== "interrupted" && state.status !== "completed" && state.status !== "failed") throw new Error("Invalid run state status");
	if (state.status === "interrupted") assertInterruptedNornRunState(state);
	if (typeof state.startedAt !== "string" || typeof state.updatedAt !== "string") throw new Error("Invalid run state timestamps");
	return state as NornRunState;
}

function assertInterruptedNornRunState(state: Partial<NornRunState>): void {
	if (!state.current) throw new Error("Invalid interrupted run current step");
	const interruption = state.current.interruption;
	if (!interruption || interruption.status !== "pending") throw new Error("Invalid run interruption");
	if (typeof interruption.description !== "string" || interruption.description.length === 0) throw new Error("Invalid run interruption description");
}

function runInterruption(state: NornRunState): NornRunInterruption | undefined {
	if (state.status !== "interrupted" || !state.current?.interruption) return undefined;
	return {
		workflowId: state.current.workflowId,
		params: state.current.params,
		description: state.current.interruption.description ?? "",
		fields: state.current.interruption.fields,
	};
}

function runOutcome(state: NornRunState): NornRunOutcomeInfo | undefined {
	return state.outcome ?? undefined;
}

function runFailure(state: NornRunState): NornRunFailureInfo | undefined {
	return state.failed ?? undefined;
}
