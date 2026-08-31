import { readdir, readFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { PalantirRunHealth, PalantirRunStatus, PalantirRunOutcomeMetadata, PalantirRunInfo, PalantirRunInterruption, PalantirRunOutcomeInfo, PalantirRunFailureInfo } from "../api.ts";
import { isNodeError } from "./errors.ts";
import { getRunLeaseHealth } from "./run-lease.ts";
import { writeJsonAtomically } from "./json-file.ts";
import { runCurrentRoot } from "./run-store.ts";

export const RUN_STATE_FILE_NAME = "run-state.json";
const LEGACY_RUN_STATE_FILE_NAME = "runtime-state.json";
const RUN_STATE_VERSION = 1;

type PalantirRunWorkflowStep = {
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

type PalantirRunWorkflowCompletion = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly outcome: { readonly type: "next"; readonly workflowId: string } | { readonly type: "complete" } | { readonly type: "fail" };
};

type PalantirRunWorkflowFailure = {
	readonly workflowId: string;
	readonly error: string;
	readonly metadata?: PalantirRunOutcomeMetadata;
	readonly failedAt: string;
};

type PalantirRunWorkflowOutcome = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly status: "completed" | "failed";
	readonly metadata?: PalantirRunOutcomeMetadata;
};

export type PalantirRunState = {
	readonly version: typeof RUN_STATE_VERSION;
	readonly id: string;
	readonly name: string;
	readonly entrypointWorkflowId: string;
	readonly workspace: string;
	readonly configOverride?: unknown;
	readonly status: PalantirRunStatus;
	readonly current: PalantirRunWorkflowStep | null;
	readonly lastCompleted: PalantirRunWorkflowCompletion | null;
	readonly outcome: PalantirRunWorkflowOutcome | null;
	readonly failed: PalantirRunWorkflowFailure | null;
	readonly startedAt: string;
	readonly updatedAt: string;
};

type CreatePalantirRunStateInput = {
	readonly id: string;
	readonly name: string;
	readonly entrypointWorkflowId: string;
	readonly workspace: string;
	readonly configOverride?: unknown;
	readonly current: PalantirRunWorkflowStep;
	readonly startedAt: string;
};

export class PalantirRunStateStore {
	private writeChain: Promise<void> = Promise.resolve();

	private constructor(
		private readonly path: string,
		private state: PalantirRunState,
	) {}

	static async create(runRoot: string, input: CreatePalantirRunStateInput): Promise<PalantirRunStateStore> {
		const now = input.startedAt;
		const state: PalantirRunState = {
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
		const store = new PalantirRunStateStore(join(runCurrentRoot(runRoot), RUN_STATE_FILE_NAME), state);
		await store.write();
		return store;
	}

	static async load(runRoot: string): Promise<PalantirRunStateStore> {
		const currentRoot = runCurrentRoot(runRoot);
		const state = parsePalantirRunState(await readRunStateJson(currentRoot));
		return new PalantirRunStateStore(join(currentRoot, RUN_STATE_FILE_NAME), state);
	}

	currentState(): PalantirRunState {
		return this.state;
	}

	async startStep(step: PalantirRunWorkflowStep): Promise<void> {
		await this.update({ status: "running", current: step, outcome: null, failed: null });
	}

	async completeWithNext(completedWorkflowId: string, next: PalantirRunWorkflowStep): Promise<void> {
		await this.update({
			status: "running",
			current: next,
			lastCompleted: { workflowId: completedWorkflowId, completedAt: new Date().toISOString(), outcome: { type: "next", workflowId: next.workflowId } },
			outcome: null,
			failed: null,
		});
	}

	async completeRun(workflowId: string, metadata: PalantirRunOutcomeMetadata | undefined): Promise<void> {
		const completedAt = new Date().toISOString();
		await this.update({
			status: "completed",
			current: null,
			lastCompleted: { workflowId, completedAt, outcome: { type: "complete" } },
			outcome: { workflowId, completedAt, status: "completed", metadata },
			failed: null,
		});
	}

	async failRun(workflowId: string, metadata: PalantirRunOutcomeMetadata & { readonly summary: string }): Promise<void> {
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

	async failCurrent(errorOrMetadata: string | PalantirRunOutcomeMetadata & { readonly summary: string }): Promise<void> {
		if (!this.state.current) throw new Error("Cannot fail run without current step");
		const failedAt = new Date().toISOString();
		const metadata = typeof errorOrMetadata === "string" ? { summary: errorOrMetadata } : errorOrMetadata;
		await this.update({
			status: "failed",
			outcome: { workflowId: this.state.current.workflowId, completedAt: failedAt, status: "failed", metadata },
			failed: { workflowId: this.state.current.workflowId, error: metadata.summary, metadata, failedAt },
		});
	}

	private async update(patch: Partial<PalantirRunState>): Promise<void> {
		this.state = { ...this.state, ...patch, updatedAt: new Date().toISOString() };
		await this.write();
	}

	private async write(): Promise<void> {
		this.writeChain = this.writeChain.then(() => writeJsonAtomically(this.path, this.state));
		await this.writeChain;
	}
}

export async function listRuns(sessionCwd: string): Promise<PalantirRunInfo[]> {
	const runsRoot = join(sessionCwd, ".palantir", "runs");
	let entries;
	try {
		entries = await readdir(runsRoot, { withFileTypes: true });
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}

	const runs = await Promise.all(entries.filter((entry) => entry.isDirectory()).map((entry) => readPalantirRunInfo(resolve(runsRoot, entry.name))));
	return runs.filter((run): run is PalantirRunInfo => run !== undefined).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
}

export async function getRunInfo(runRoot: string): Promise<PalantirRunInfo> {
	const state = parsePalantirRunState(await readRunStateJson(runCurrentRoot(runRoot)));
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
}

export async function resolveRunRoot(sessionCwd: string, run: string): Promise<string> {
	for (const candidate of runRootCandidates(sessionCwd, run)) {
		try {
			if (await readPalantirRunInfo(candidate)) return candidate;
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
	if (!isAbsolute(run)) candidates.push(resolve(sessionCwd, ".palantir", "runs", run));
	return Array.from(new Set(candidates));
}

async function runHealth(runRoot: string, status: PalantirRunStatus): Promise<PalantirRunHealth> {
	if (status === "failed") return "unhealthy";
	if (status !== "running") return "healthy";
	return getRunLeaseHealth(runRoot);
}

async function readPalantirRunInfo(runRoot: string): Promise<PalantirRunInfo | undefined> {
	try {
		return await getRunInfo(runRoot);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readRunStateJson(currentRoot: string): Promise<unknown> {
	try {
		return JSON.parse(await readFile(join(currentRoot, RUN_STATE_FILE_NAME), "utf8"));
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		return JSON.parse(await readFile(join(currentRoot, LEGACY_RUN_STATE_FILE_NAME), "utf8"));
	}
}

function parsePalantirRunState(value: unknown): PalantirRunState {
	if (!value || typeof value !== "object") throw new Error("Invalid run state");
	const state = value as Partial<PalantirRunState> & { rootWorkflowId?: unknown };
	if (state.version !== RUN_STATE_VERSION) throw new Error(`Unsupported run state version: ${String(state.version)}`);
	if (typeof state.id !== "string" || state.id.length === 0) throw new Error("Invalid run state id");
	const normalizedState = state as { name?: string; entrypointWorkflowId?: unknown; rootWorkflowId?: unknown };
	if (typeof normalizedState.name !== "string" || normalizedState.name.length === 0) normalizedState.name = state.id;
	if (typeof normalizedState.entrypointWorkflowId !== "string" && typeof normalizedState.rootWorkflowId === "string") normalizedState.entrypointWorkflowId = normalizedState.rootWorkflowId;
	if (typeof state.entrypointWorkflowId !== "string" || state.entrypointWorkflowId.length === 0) throw new Error("Invalid run state entrypoint workflow id");
	if (typeof state.workspace !== "string" || state.workspace.length === 0) throw new Error("Invalid run state workspace");
	if (state.status !== "running" && state.status !== "interrupted" && state.status !== "completed" && state.status !== "failed") throw new Error("Invalid run state status");
	if (state.status === "interrupted") assertInterruptedPalantirRunState(state);
	if (typeof state.startedAt !== "string" || typeof state.updatedAt !== "string") throw new Error("Invalid run state timestamps");
	return state as PalantirRunState;
}

function assertInterruptedPalantirRunState(state: Partial<PalantirRunState>): void {
	if (!state.current) throw new Error("Invalid interrupted run current step");
	const interruption = state.current.interruption;
	if (!interruption || interruption.status !== "pending") throw new Error("Invalid run interruption");
	if (typeof interruption.description !== "string" || interruption.description.length === 0) throw new Error("Invalid run interruption description");
}

function runInterruption(state: PalantirRunState): PalantirRunInterruption | undefined {
	if (state.status !== "interrupted" || !state.current?.interruption) return undefined;
	return {
		workflowId: state.current.workflowId,
		params: state.current.params,
		description: state.current.interruption.description ?? "",
		fields: state.current.interruption.fields,
	};
}

function runOutcome(state: PalantirRunState): PalantirRunOutcomeInfo | undefined {
	return state.outcome ?? undefined;
}

function runFailure(state: PalantirRunState): PalantirRunFailureInfo | undefined {
	return state.failed ?? undefined;
}
