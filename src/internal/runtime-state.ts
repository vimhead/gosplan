import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { WorkflowOutcomeMetadata, WorkflowRunHealth, WorkflowRunInfo, WorkflowRunStatus } from "../api.ts";
import { isNodeError } from "./errors.ts";
import { getWorkflowRunLeaseHealth } from "./run-lease.ts";
import { writeJsonAtomically } from "./json-file.ts";
import { workflowRunCurrentRoot } from "./run-store.ts";

export const RUNTIME_STATE_FILE_NAME = "runtime-state.json";
const RUNTIME_STATE_VERSION = 1;

type RuntimeWorkflowStep = {
	readonly workflowId: string;
	readonly params: unknown;
	readonly configOverride?: unknown;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly humanGate?: RuntimeHumanGate;
};

type RuntimeHumanGate = {
	readonly status: "pending" | "satisfied";
	readonly description?: string;
};

type RuntimeWorkflowCompletion = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly outcome: { readonly type: "next"; readonly workflowId: string } | { readonly type: "complete" } | { readonly type: "fail" };
};

type RuntimeWorkflowFailure = {
	readonly workflowId: string;
	readonly error: string;
	readonly metadata?: WorkflowOutcomeMetadata;
	readonly failedAt: string;
};

type RuntimeWorkflowOutcome = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly status: "completed" | "failed";
	readonly metadata?: WorkflowOutcomeMetadata;
};

export type WorkflowRuntimeState = {
	readonly version: typeof RUNTIME_STATE_VERSION;
	readonly id: string;
	readonly name: string;
	readonly rootWorkflowId: string;
	readonly workspace: string;
	readonly status: WorkflowRunStatus;
	readonly current: RuntimeWorkflowStep | null;
	readonly lastCompleted: RuntimeWorkflowCompletion | null;
	readonly outcome: RuntimeWorkflowOutcome | null;
	readonly failed: RuntimeWorkflowFailure | null;
	readonly startedAt: string;
	readonly updatedAt: string;
};

type CreateWorkflowRuntimeStateInput = {
	readonly id: string;
	readonly name: string;
	readonly rootWorkflowId: string;
	readonly workspace: string;
	readonly current: RuntimeWorkflowStep;
	readonly startedAt: string;
};

export class WorkflowRuntimeStateStore {
	private writeChain: Promise<void> = Promise.resolve();

	private constructor(
		private readonly path: string,
		private state: WorkflowRuntimeState,
	) {}

	static async create(runRoot: string, input: CreateWorkflowRuntimeStateInput): Promise<WorkflowRuntimeStateStore> {
		const now = input.startedAt;
		const state: WorkflowRuntimeState = {
			version: RUNTIME_STATE_VERSION,
			id: input.id,
			name: input.name,
			rootWorkflowId: input.rootWorkflowId,
			workspace: input.workspace,
			status: "running",
			current: input.current,
			lastCompleted: null,
			outcome: null,
			failed: null,
			startedAt: now,
			updatedAt: now,
		};
		const store = new WorkflowRuntimeStateStore(join(workflowRunCurrentRoot(runRoot), RUNTIME_STATE_FILE_NAME), state);
		await store.write();
		return store;
	}

	static async load(runRoot: string): Promise<WorkflowRuntimeStateStore> {
		const path = join(workflowRunCurrentRoot(runRoot), RUNTIME_STATE_FILE_NAME);
		return new WorkflowRuntimeStateStore(path, parseWorkflowRuntimeState(JSON.parse(await readFile(path, "utf8"))));
	}

	currentState(): WorkflowRuntimeState {
		return this.state;
	}

	async startStep(step: RuntimeWorkflowStep): Promise<void> {
		await this.update({ status: "running", current: step, outcome: null, failed: null });
	}

	async completeWithNext(completedWorkflowId: string, next: RuntimeWorkflowStep): Promise<void> {
		await this.update({
			status: "running",
			current: next,
			lastCompleted: { workflowId: completedWorkflowId, completedAt: new Date().toISOString(), outcome: { type: "next", workflowId: next.workflowId } },
			outcome: null,
			failed: null,
		});
	}

	async completeRun(workflowId: string, metadata: WorkflowOutcomeMetadata | undefined): Promise<void> {
		const completedAt = new Date().toISOString();
		await this.update({
			status: "completed",
			current: null,
			lastCompleted: { workflowId, completedAt, outcome: { type: "complete" } },
			outcome: { workflowId, completedAt, status: "completed", metadata },
			failed: null,
		});
	}

	async failRun(workflowId: string, metadata: WorkflowOutcomeMetadata & { readonly summary: string }): Promise<void> {
		const failedAt = new Date().toISOString();
		await this.update({
			status: "failed",
			current: null,
			lastCompleted: { workflowId, completedAt: failedAt, outcome: { type: "fail" } },
			outcome: { workflowId, completedAt: failedAt, status: "failed", metadata },
			failed: { workflowId, error: metadata.summary, metadata, failedAt },
		});
	}

	async interruptCurrent(params: unknown, description: string): Promise<void> {
		if (!this.state.current) throw new Error("Cannot interrupt workflow run without current step");
		await this.update({
			status: "interrupted",
			current: { ...this.state.current, params, humanGate: { status: "pending", description } },
			outcome: null,
			failed: null,
		});
	}

	async replaceCurrentParams(params: unknown): Promise<void> {
		if (!this.state.current) throw new Error("Cannot resume workflow run without current step");
		await this.update({
			status: "running",
			current: { ...this.state.current, params, humanGate: { ...this.state.current.humanGate, status: "satisfied" } },
			outcome: null,
			failed: null,
		});
	}

	async failCurrent(errorOrMetadata: string | WorkflowOutcomeMetadata & { readonly summary: string }): Promise<void> {
		if (!this.state.current) throw new Error("Cannot fail workflow run without current step");
		const failedAt = new Date().toISOString();
		const metadata = typeof errorOrMetadata === "string" ? { summary: errorOrMetadata } : errorOrMetadata;
		await this.update({
			status: "failed",
			outcome: { workflowId: this.state.current.workflowId, completedAt: failedAt, status: "failed", metadata },
			failed: { workflowId: this.state.current.workflowId, error: metadata.summary, metadata, failedAt },
		});
	}

	private async update(patch: Partial<WorkflowRuntimeState>): Promise<void> {
		this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
		await this.write();
	}

	private async write(): Promise<void> {
		this.writeChain = this.writeChain.then(() => writeJsonAtomically(this.path, this.state));
		await this.writeChain;
	}
}

export async function listWorkflowRuns(sessionCwd: string): Promise<WorkflowRunInfo[]> {
	const runsRoot = join(sessionCwd, ".palantir", "runs");
	let entries;
	try {
		entries = await readdir(runsRoot, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}

	const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readWorkflowRunInfo(resolve(runsRoot, entry.name))));
	return runs.filter((run): run is WorkflowRunInfo => run !== undefined).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getWorkflowRunInfo(runRoot: string): Promise<WorkflowRunInfo> {
	const state = parseWorkflowRuntimeState(JSON.parse(await readFile(join(workflowRunCurrentRoot(runRoot), RUNTIME_STATE_FILE_NAME), "utf8")));
	return {
		version: state.version,
		id: state.id,
		name: state.name,
		path: runRoot,
		rootWorkflowId: state.rootWorkflowId,
		currentWorkflowId: state.current?.workflowId,
		status: state.status,
		health: await workflowRunHealth(runRoot, state.status),
		startedAt: state.startedAt,
		updatedAt: state.updatedAt,
	};
}

export async function resolveWorkflowRunRoot(sessionCwd: string, run: string): Promise<string> {
	for (const candidate of workflowRunRootCandidates(sessionCwd, run)) {
		try {
			if (await readWorkflowRunInfo(candidate)) return candidate;
		} catch (error) {
			if (!isNodeError(error) && (!(error instanceof Error) || !error.message.includes("runtime state"))) throw error;
		}
	}

	const runs = await listWorkflowRuns(sessionCwd);
	const match = runs.find((entry) => entry.id === run || entry.name === run || entry.path === run || entry.path.endsWith(`/${run}`));
	if (!match) throw new Error(`Unknown workflow run: ${run}`);
	return match.path;
}

function workflowRunRootCandidates(sessionCwd: string, run: string): string[] {
	const candidates = [isAbsolute(run) ? run : resolve(sessionCwd, run)];
	if (!isAbsolute(run)) candidates.push(resolve(sessionCwd, ".palantir", "runs", run));
	return Array.from(new Set(candidates));
}

async function workflowRunHealth(runRoot: string, status: WorkflowRunStatus): Promise<WorkflowRunHealth> {
	if (status === "failed") return "unhealthy";
	if (status !== "running") return "healthy";
	return getWorkflowRunLeaseHealth(runRoot);
}

async function readWorkflowRunInfo(runRoot: string): Promise<WorkflowRunInfo | undefined> {
	try {
		return await getWorkflowRunInfo(runRoot);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function parseWorkflowRuntimeState(value: unknown): WorkflowRuntimeState {
	if (!value || typeof value !== "object") throw new Error("Invalid workflow runtime state");
	const state = value as Partial<WorkflowRuntimeState>;
	if (state.version !== RUNTIME_STATE_VERSION) throw new Error(`Unsupported workflow runtime state version: ${String(state.version)}`);
	if (typeof state.id !== "string" || state.id.length === 0) throw new Error("Invalid workflow runtime state id");
	const normalizedState = state as Partial<WorkflowRuntimeState> & { name?: string };
	if (typeof normalizedState.name !== "string" || normalizedState.name.length === 0) normalizedState.name = state.id;
	if (typeof state.rootWorkflowId !== "string" || state.rootWorkflowId.length === 0) throw new Error("Invalid workflow runtime state root workflow id");
	if (typeof state.workspace !== "string" || state.workspace.length === 0) throw new Error("Invalid workflow runtime state workspace");
	if (state.status !== "running" && state.status !== "interrupted" && state.status !== "completed" && state.status !== "failed") throw new Error("Invalid workflow runtime state status");
	if (state.status === "interrupted") assertInterruptedWorkflowRuntimeState(state);
	if (typeof state.startedAt !== "string" || typeof state.updatedAt !== "string") throw new Error("Invalid workflow runtime state timestamps");
	return state as WorkflowRuntimeState;
}

function assertInterruptedWorkflowRuntimeState(state: Partial<WorkflowRuntimeState>): void {
	if (!state.current) throw new Error("Invalid interrupted workflow runtime current step");
	const humanGate = state.current.humanGate;
	if (!humanGate || humanGate.status !== "pending") throw new Error("Invalid interrupted workflow runtime human gate");
	if (typeof humanGate.description !== "string" || humanGate.description.length === 0) throw new Error("Invalid interrupted workflow runtime human gate description");
}
