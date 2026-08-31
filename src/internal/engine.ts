import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type PalantirAnyWorkflowDeclaration,
	type PalantirAnyRunStartOptions,
	type PalantirAnyWorkflowPluginManifest,
	type PalantirDispose,
	type PalantirRunStartOptions,
	type PalantirInterruptedRunResult,
	type PalantirRunResult,
	type PalantirRunCheckpoint,
	type PalantirRunInfo,
	type PalantirWorkflowPlugin,
	type PalantirWorkflowPluginImplementation,
	type PalantirWorkflowPluginImplementationInput,
	type PalantirRunNext,
	type PalantirRun,
} from "../api.ts";
import { PalantirAgentResponseCollector } from "./agent-response-tool.ts";
import { PalantirArtifacts } from "./artifacts.ts";
import { errorMessage } from "./errors.ts";
import { PalantirRunLogs } from "./logs.ts";
import { PalantirRunLease } from "./run-lease.ts";
import { PalantirRunLogger } from "./run-log.ts";
import { PalantirRunStore, runCurrentRoot } from "./run-store.ts";
import { PalantirRunStateStore, getRunInfo, resolveRunRoot, type PalantirRunState } from "./run-state.ts";
import { PalantirRunContext } from "./run.ts";
import { PalantirJsonWorkflowState, PalantirMemoryWorkflowState } from "./state-store.ts";
import { PalantirWorkflowRegistry, type PalantirRegisteredWorkflow, type PalantirWorkflowStepResult } from "./workflow-registry.ts";

const RUNS_DIR_NAME = ".palantir";
const STATE_FILE_NAME = "state.json";
const MANIFEST_FILE_NAME = "manifest.json";

export type PalantirEngineInput = {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly signal?: AbortSignal;
	readonly responseCollector?: PalantirAgentResponseCollector;
	readonly gateMode?: "auto" | "pause";
};

type RunSession = {
	readonly runRoot: string;
	readonly run: PalantirRun;
	readonly state: PalantirRunStateStore;
	readonly lease: PalantirRunLease;
	readonly runStore: PalantirRunStore;
	readonly logger: PalantirRunLogger;
	readonly activeRun: ActiveRun;
};

type ActiveRun = {
	readonly controller: AbortController;
	readonly finished: Promise<void>;
	readonly finish: () => void;
	readonly dispose: () => void;
};

type WorkflowStep = {
	readonly workflow: PalantirAnyWorkflowDeclaration;
	readonly params: unknown;
	readonly configOverride?: unknown;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly gate?: NonNullable<PalantirRunState["current"]>["gate"];
};

export class PalantirEngine {
	private readonly registry = new PalantirWorkflowRegistry();
	private readonly registrarState = new PalantirMemoryWorkflowState();
	private readonly disposersByPlugin = new Map<string, PalantirDispose[]>();
	private readonly responseCollector: PalantirAgentResponseCollector;
	private readonly activeRuns = new Map<string, ActiveRun>();

	constructor(private readonly input: PalantirEngineInput) {
		this.responseCollector = input.responseCollector ?? new PalantirAgentResponseCollector();
	}

	registerPlugin<TManifest extends PalantirAnyWorkflowPluginManifest>(plugin: PalantirWorkflowPlugin<TManifest>): PalantirDispose {
		this.disposePlugin(plugin.manifest.id);
		const implementation = this.resolvePluginImplementation(plugin.implementation);
		const disposers = Object.entries(plugin.manifest.workflows).map(([key, workflow]) => {
			const workflowImplementation = implementation.workflows[key];
			if (!workflowImplementation) throw new Error(`Missing implementation for workflow ${plugin.manifest.id}.${key}`);
			return this.registry.register(workflow, workflowImplementation);
		});
		this.disposersByPlugin.set(plugin.manifest.id, disposers);
		return () => {
			if (this.disposersByPlugin.get(plugin.manifest.id) === disposers) this.disposePlugin(plugin.manifest.id);
		};
	}

	listWorkflows() {
		return this.registry.list();
	}

	visibleWorkflowEntries(): PalantirRegisteredWorkflow[] {
		return this.registry.launchableEntries();
	}

	private resolvePluginImplementation<TManifest extends PalantirAnyWorkflowPluginManifest>(
		implementationInput: PalantirWorkflowPluginImplementationInput<TManifest>,
	): PalantirWorkflowPluginImplementation<TManifest> {
		return typeof implementationInput === "function"
			? implementationInput({ cwd: this.input.cwd, state: this.registrarState })
			: implementationInput;
	}

	async runWorkflow<TWorkflow extends PalantirAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: unknown,
		options: PalantirRunStartOptions<TWorkflow> | PalantirAnyRunStartOptions | undefined,
	): Promise<PalantirRunResult> {
		const session = await this.createRunSession(workflow, params, options);
		return this.runScheduler(session, {
			workflow,
			params,
			configOverride: options?.configOverride,
			cwd: session.run.cwd,
			env: options?.env ?? {},
		});
	}

	async listRunCheckpoints(path: string): Promise<PalantirRunCheckpoint[]> {
		const runRoot = await resolveRunRoot(this.input.cwd, path);
		return (await PalantirRunStore.open(runRoot)).listCheckpoints();
	}

	async getActiveGate(path: string): Promise<PalantirInterruptedRunResult> {
		const runRoot = await resolveRunRoot(this.input.cwd, path);
		const state = (await PalantirRunStateStore.load(runRoot)).currentState();
		if (state.status !== "interrupted") throw new Error(`Run is not interrupted: ${runRoot}`);
		const current = state.current;
		if (!current) throw new Error(`Run is not resumable: ${runRoot}`);
		const workflow = this.registry.workflowById(current.workflowId);
		if (!workflow) throw new Error(`Unknown workflow for interrupted run: ${current.workflowId}`);
		return interruptedLaunchResult({ id: state.id, name: state.name, workspace: state.workspace, cwd: current.cwd }, workflow, current.params, current.gate?.description);
	}

	async rollbackRun(path: string, checkpointId: string): Promise<PalantirRunInfo> {
		const runRoot = await resolveRunRoot(this.input.cwd, path);
		const lease = await PalantirRunLease.acquire(runRoot);
		try {
			const runStore = await PalantirRunStore.open(runRoot);
			await runStore.restoreSnapshot(checkpointId);
			return getRunInfo(runRoot);
		} finally {
			await lease.release();
		}
	}

	async resumeWorkflow(path: string, params?: unknown): Promise<PalantirRunResult> {
		const runRoot = await resolveRunRoot(this.input.cwd, path);
		const initialStateStore = await PalantirRunStateStore.load(runRoot);
		const initialState = initialStateStore.currentState();
		if (initialState.status === "completed") throw new Error(`Run is already completed: ${runRoot}`);
		if (initialState.status === "interrupted" && params === undefined) throw new Error(`Interrupted workflow resume requires params: ${runRoot}`);

		const lease = await PalantirRunLease.acquire(runRoot);
		let isLeaseOwnedByScheduler = false;
		try {
			if (initialState.status === "running") await (await PalantirRunStore.open(runRoot)).restoreCurrentSnapshot();
			const session = await this.openRunSession(runRoot, lease);
			const state = session.state.currentState();
			const current = state.current;
			if (!current) throw new Error(`Run is not resumable: ${runRoot}`);
			const workflow = this.registry.workflowById(current.workflowId);
			if (!workflow) throw new Error(`Unknown workflow for resumed run: ${current.workflowId}`);
			if (state.status === "interrupted") {
				await session.state.replaceCurrentParams(workflow.params.parse(params));
				const resumedCurrent = session.state.currentState().current;
				if (!resumedCurrent) throw new Error(`Run is not resumable: ${runRoot}`);
				isLeaseOwnedByScheduler = true;
				return this.runScheduler(session, toWorkflowStep(workflow, resumedCurrent));
			}
			isLeaseOwnedByScheduler = true;
			return this.runScheduler(session, toWorkflowStep(workflow, current));
		} finally {
			if (!isLeaseOwnedByScheduler) await lease.release();
		}
	}

	private async runScheduler(session: RunSession, initialStep: WorkflowStep): Promise<PalantirRunResult> {
		let currentStep = initialStep;
		try {
			for (let step = 1; step <= 1_000; step++) {
				throwIfRunAborted(session.activeRun);
				const stepRuntime = session.run.with({ cwd: currentStep.cwd, env: currentStep.env });
				if (shouldPauseForGate(currentStep)) {
					const parsedParams = currentStep.workflow.params.parse(currentStep.params);
					const description = await this.registry.describeGate(currentStep.workflow, stepRuntime, parsedParams, currentStep.configOverride);
					await session.state.interruptCurrent(parsedParams, description);
					await recordRunEvent(session, { type: "run.interrupted", workflowId: currentStep.workflow.id });
					await commitRunBoundary(session, `run interrupted: ${currentStep.workflow.id}`);
					return interruptedLaunchResult({ id: stepRuntime.id, name: session.state.currentState().name, workspace: stepRuntime.workspace, cwd: stepRuntime.cwd }, currentStep.workflow, parsedParams, description);
				}
				await session.state.startStep(toRunStateStep(currentStep));
				const stepResult = await this.executeWorkflowStep(session, currentStep, stepRuntime);
				throwIfRunAborted(session.activeRun);
				if (stepResult.type === "complete") {
					await session.state.completeRun(stepResult.workflow.id, stepResult.metadata);
					await recordRunEvent(session, { type: "run.completed", workflowId: stepResult.workflow.id, metadata: stepResult.metadata });
					await commitRunBoundary(session, `run completed: ${stepResult.workflow.id}`);
					return { status: "completed", id: stepRuntime.id, name: session.state.currentState().name, workspace: stepRuntime.workspace, cwd: stepRuntime.cwd, workflowId: stepResult.workflow.id, metadata: stepResult.metadata };
				}
				if (stepResult.type === "fail") {
					await session.state.failRun(stepResult.workflow.id, stepResult.metadata);
					await recordRunEvent(session, { type: "run.failed", workflowId: stepResult.workflow.id, metadata: stepResult.metadata });
					await commitRunBoundary(session, `run failed: ${stepResult.workflow.id}`);
					return { status: "failed", id: stepRuntime.id, name: session.state.currentState().name, workspace: stepRuntime.workspace, cwd: stepRuntime.cwd, workflowId: stepResult.workflow.id, metadata: stepResult.metadata };
				}
				const nextStep = this.nextWorkflowStep(stepResult, stepRuntime);
				await session.state.completeWithNext(currentStep.workflow.id, toRunStateStep(nextStep));
				await recordRunEvent(session, { type: "run.transitioned", fromWorkflowId: currentStep.workflow.id, toWorkflowId: nextStep.workflow.id });
				await commitRunBoundary(session, `transition: ${currentStep.workflow.id} -> ${nextStep.workflow.id}`);
				currentStep = nextStep;
			}
			throw new Error("Run exceeded 1000 scheduler steps");
		} catch (error) {
			await session.state.failCurrent(errorMessage(error));
			await recordRunEvent(session, { type: "run.failed", workflowId: currentStep.workflow.id, error: errorMessage(error) });
			await commitRunBoundary(session, `run failed: ${currentStep.workflow.id}`);
			throw error;
		} finally {
			await session.lease.release();
			this.finishActiveRun(session.runRoot, session.activeRun);
		}
	}

	private async executeWorkflowStep(session: RunSession, step: WorkflowStep, run: PalantirRun): Promise<PalantirWorkflowStepResult> {
		const boundaryRef = await session.runStore.currentSnapshotRef();
		const logBoundary = session.logger.boundary();
		const startedAtMs = Date.now();
		try {
			await assertWorkspaceBoundary(session, run.workspace);
			await recordRunEvent(session, { type: "workflow.started", workflowId: step.workflow.id });
			const result = await this.registry.execute(step.workflow, run, step.params, step.configOverride);
			await assertWorkspaceBoundary(session, run.workspace);
			const durationMs = Date.now() - startedAtMs;
			if (result.type === "complete") await recordRunEvent(session, { type: "workflow.completed", workflowId: result.workflow.id, durationMs, metadata: result.metadata });
			else if (result.type === "fail") await recordRunEvent(session, { type: "workflow.failed", workflowId: result.workflow.id, durationMs, metadata: result.metadata });
			else await recordRunEvent(session, { type: "workflow.transitioned", fromWorkflowId: step.workflow.id, toWorkflowId: result.workflowId, durationMs });
			return result;
		} catch (error) {
			await rollbackRunBoundary(session, boundaryRef);
			rollbackRunLogBoundary(session, logBoundary);
			await recordRunEvent(session, { type: "workflow.failed", workflowId: step.workflow.id, durationMs: Date.now() - startedAtMs, error: errorMessage(error) });
			throw error;
		}
	}

	private nextWorkflowStep(next: PalantirRunNext, run: PalantirRun): WorkflowStep {
		const workflow = this.registry.workflowById(next.workflowId);
		if (!workflow) throw new Error(`Unknown next workflow: ${next.workflowId}`);
		return {
			workflow,
			params: next.params,
			configOverride: next.configOverride,
			cwd: next.cwd ?? run.cwd,
			env: next.env ?? {},
			gate: this.input.gateMode === "pause" && workflow.gate ? { status: "pending" } : undefined,
		};
	}

	private async createRunSession<TWorkflow extends PalantirAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: unknown,
		options: PalantirRunStartOptions<TWorkflow> | PalantirAnyRunStartOptions | undefined,
	): Promise<RunSession> {
		const id = options?.id ?? randomUUID();
		const name = options?.name ?? id;
		const runRoot = defaultRunRoot(this.input.cwd, id);
		const currentRoot = runCurrentRoot(runRoot);
		const workspace = join(currentRoot, "workspace");
		const cwd = options?.cwd ? resolveFromWorkspace(workspace, options.cwd) : workspace;
		const startedAt = new Date().toISOString();
		await mkdir(runRoot, { recursive: true });
		const lease = await PalantirRunLease.acquire(runRoot);
		const activeRun = this.startActiveRun(runRoot);
		try {
			const runStore = await PalantirRunStore.initialize(runRoot);
			await mkdir(workspace, { recursive: true });
			const logger = new PalantirRunLogger(join(currentRoot, MANIFEST_FILE_NAME), {
				id,
				name,
				workflowId: workflow.id,
				runRoot,
				workspace,
				initialCwd: cwd,
				startedAt,
			});
			const run = await this.buildRun({ id, currentRoot, workspace, cwd, env: options?.env ?? {}, signal: activeRun.controller.signal, logger });
			const state = await PalantirRunStateStore.create(runRoot, {
				id,
				name,
				entrypointWorkflowId: workflow.id,
				workspace,
				current: { workflowId: workflow.id, params, configOverride: options?.configOverride, cwd, env: options?.env ?? {} },
				startedAt,
			});
			const session = { runRoot, run, state, lease, runStore, logger, activeRun };
			await logger.record({ type: "run.started", workflowId: workflow.id, cwd, workspace });
			await commitRunBoundary(session, `run started: ${workflow.id}`);
			return session;
		} catch (error) {
			await lease.release();
			this.failActiveRun(runRoot, activeRun);
			throw error;
		}
	}

	private async openRunSession(runRoot: string, lease: PalantirRunLease): Promise<RunSession> {
		const activeRun = this.startActiveRun(runRoot);
		try {
			const state = await PalantirRunStateStore.load(runRoot);
			const currentState = state.currentState();
			if (currentState.status === "completed") throw new Error(`Run is already completed: ${runRoot}`);
			const runStore = await PalantirRunStore.open(runRoot);
			const currentRoot = runCurrentRoot(runRoot);
			const logger = await PalantirRunLogger.load(join(currentRoot, MANIFEST_FILE_NAME));
			const cwd = currentState.current?.cwd ?? currentState.workspace;
			const env = currentState.current?.env ?? {};
			const run = await this.buildRun({ id: currentState.id, currentRoot, workspace: currentState.workspace, cwd, env, signal: activeRun.controller.signal, logger });
			await logger.record({ type: "run.resumed", workflowId: currentState.current?.workflowId, cwd });
			return { runRoot, run, state, lease, runStore, logger, activeRun };
		} catch (error) {
			this.failActiveRun(runRoot, activeRun);
			throw error;
		}
	}

	private async buildRun(input: {
		readonly id: string;
		readonly currentRoot: string;
		readonly workspace: string;
		readonly cwd: string;
		readonly env: Record<string, string>;
		readonly signal: AbortSignal;
		readonly logger: PalantirRunLogger;
	}): Promise<PalantirRun> {
		const artifactsRoot = join(input.currentRoot, "artifacts");
		const logsRoot = join(input.currentRoot, "logs");
		await mkdir(input.workspace, { recursive: true });
		await mkdir(artifactsRoot, { recursive: true });
		await mkdir(logsRoot, { recursive: true });
		return new PalantirRunContext({
			id: input.id,
			runRoot: input.currentRoot,
			workspace: input.workspace,
			cwd: input.cwd,
			env: input.env,
			signal: input.signal,
			agentDir: this.input.agentDir,
			responseCollector: this.responseCollector,
			state: new PalantirJsonWorkflowState(join(input.currentRoot, STATE_FILE_NAME)),
			logger: input.logger,
			artifacts: new PalantirArtifacts(artifactsRoot),
			logs: new PalantirRunLogs(logsRoot),
		});
	}

	private startActiveRun(runRoot: string): ActiveRun {
		if (this.activeRuns.has(runRoot)) throw new Error(`Run is already active in this engine: ${runRoot}`);
		const controller = new AbortController();
		let finish: () => void;
		const finished = new Promise<void>((resolvePromise) => {
			finish = resolvePromise;
		});
		const abortFromParent = () => controller.abort(this.input.signal?.reason);
		if (this.input.signal?.aborted) abortFromParent();
		else this.input.signal?.addEventListener("abort", abortFromParent, { once: true });
		const activeRun: ActiveRun = {
			controller,
			finished,
			finish: () => finish(),
			dispose: () => this.input.signal?.removeEventListener("abort", abortFromParent),
		};
		this.activeRuns.set(runRoot, activeRun);
		return activeRun;
	}

	private finishActiveRun(runRoot: string, activeRun: ActiveRun): void {
		if (this.activeRuns.get(runRoot) !== activeRun) return;
		this.activeRuns.delete(runRoot);
		activeRun.dispose();
		activeRun.finish();
	}

	private failActiveRun(runRoot: string, activeRun: ActiveRun): void {
		if (this.activeRuns.get(runRoot) === activeRun) this.activeRuns.delete(runRoot);
		activeRun.dispose();
		activeRun.finish();
	}

	private disposePlugin(pluginId: string): void {
		const disposers = this.disposersByPlugin.get(pluginId) ?? [];
		for (const dispose of [...disposers].reverse()) dispose();
		this.disposersByPlugin.delete(pluginId);
	}
}

function defaultRunRoot(cwd: string, id: string): string {
	return join(cwd, RUNS_DIR_NAME, "runs", id);
}

function resolveFromWorkspace(workspace: string, path: string): string {
	const resolvedPath = isAbsolute(path) ? path : resolve(workspace, path);
	const pathFromWorkspace = relative(workspace, resolvedPath);
	if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
		throw new Error(`Workflow cwd escapes workspace: ${path}`);
	}
	return resolvedPath;
}

function toWorkflowStep(workflow: PalantirAnyWorkflowDeclaration, step: NonNullable<PalantirRunState["current"]>): WorkflowStep {
	return {
		workflow,
		params: step.params,
		configOverride: step.configOverride,
		cwd: step.cwd,
		env: step.env,
		gate: step.gate,
	};
}

function toRunStateStep(step: WorkflowStep): NonNullable<PalantirRunState["current"]> {
	return {
		workflowId: step.workflow.id,
		params: step.params,
		configOverride: step.configOverride,
		cwd: step.cwd,
		env: step.env,
		gate: step.gate,
	};
}

function shouldPauseForGate(step: WorkflowStep): boolean {
	return step.gate?.status === "pending" && step.workflow.gate !== undefined;
}

function throwIfRunAborted(activeRun: ActiveRun): void {
	if (!activeRun.controller.signal.aborted) return;
	const reason: unknown = activeRun.controller.signal.reason;
	if (reason instanceof Error) throw reason;
	throw new Error(typeof reason === "string" && reason.length > 0 ? reason : "Run aborted");
}

function interruptedLaunchResult(run: RunIdentity, workflow: PalantirAnyWorkflowDeclaration, params: unknown, description: string | undefined): PalantirInterruptedRunResult {
	if (!workflow.gate) throw new Error(`Workflow is not gated: ${workflow.id}`);
	if (!description) throw new Error(`Interrupted workflow is missing gate description: ${workflow.id}`);
	return {
		status: "interrupted",
		id: run.id,
		name: run.name,
		workspace: run.workspace,
		cwd: run.cwd,
		workflowId: workflow.id,
		params,
		gate: { description, fields: workflow.gate.fields },
	};
}

type RunIdentity = {
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
};

async function recordRunEvent(
	session: RunSession,
	event: { readonly type: string; readonly [key: string]: unknown },
): Promise<void> {
	await session.logger.record(event);
}

async function commitRunBoundary(session: RunSession, message: string): Promise<void> {
	await session.lease.assertOwned();
	await session.runStore.snapshotCurrent(message);
}

async function rollbackRunBoundary(session: RunSession, ref: string): Promise<void> {
	await session.lease.assertOwned();
	await session.runStore.restoreSnapshot(ref);
}

function rollbackRunLogBoundary(session: RunSession, boundary: number): void {
	session.logger.rollback(boundary);
}

async function assertWorkspaceBoundary(session: RunSession, workspace: string): Promise<void> {
	await session.lease.assertOwned();
	await session.runStore.assertWorkspaceCanBeSnapshotted(workspace);
}
