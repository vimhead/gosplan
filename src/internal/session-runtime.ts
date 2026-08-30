import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import {
	type AnyWorkflowDeclaration,
	type AnyWorkflowLaunchOptions,
	type AnyWorkflowPluginManifest,
	type WorkflowDispose,
	type WorkflowLaunchOptions,
	type WorkflowInterruptedLaunchResult,
	type WorkflowLaunchResult,
	type WorkflowRunCheckpoint,
	type WorkflowRunInfo,
	type WorkflowPlugin,
	type WorkflowPluginImplementation,
	type WorkflowPluginImplementationInput,
	type WorkflowNext,
	type WorkflowRuntime,
} from "../api.ts";
import { AgentResponseCollector } from "./agent-response-tool.ts";
import { WorkflowArtifacts } from "./artifacts.ts";
import { errorMessage } from "./errors.ts";
import { WorkflowRunLogs } from "./logs.ts";
import { WorkflowRunLease } from "./run-lease.ts";
import { WorkflowRunLogger } from "./run-log.ts";
import { WorkflowRunStore, workflowRunCurrentRoot } from "./run-store.ts";
import { WorkflowRuntimeStateStore, getWorkflowRunInfo, resolveWorkflowRunRoot, type WorkflowRuntimeState } from "./runtime-state.ts";
import { DefaultWorkflowRuntime } from "./runtime.ts";
import { JsonWorkflowState, MemoryWorkflowState } from "./state-store.ts";
import { WorkflowRegistry, type RegisteredWorkflow, type WorkflowStepResult } from "./workflow-registry.ts";

const RUNS_DIR_NAME = ".palantir";
const STATE_FILE_NAME = "state.json";
const MANIFEST_FILE_NAME = "manifest.json";

export type PalantirRuntimeInput = {
	readonly cwd: string;
	readonly agentDir?: string;
	readonly signal?: AbortSignal;
	readonly responseCollector?: AgentResponseCollector;
	readonly humanGateMode?: "auto" | "pause";
};

type WorkflowRuntimeSession = {
	readonly runRoot: string;
	readonly runtime: WorkflowRuntime;
	readonly state: WorkflowRuntimeStateStore;
	readonly lease: WorkflowRunLease;
	readonly runStore: WorkflowRunStore;
	readonly logger: WorkflowRunLogger;
	readonly activeRun: ActiveWorkflowRun;
};

type ActiveWorkflowRun = {
	readonly controller: AbortController;
	readonly finished: Promise<void>;
	readonly finish: () => void;
	readonly dispose: () => void;
};

type WorkflowStep = {
	readonly workflow: AnyWorkflowDeclaration;
	readonly params: unknown;
	readonly configOverride?: unknown;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly humanGate?: NonNullable<WorkflowRuntimeState["current"]>["humanGate"];
};

export class PalantirRuntime {
	private readonly registry = new WorkflowRegistry();
	private readonly registrarState = new MemoryWorkflowState();
	private readonly disposersByPlugin = new Map<string, WorkflowDispose[]>();
	private readonly responseCollector: AgentResponseCollector;
	private readonly activeRuns = new Map<string, ActiveWorkflowRun>();

	constructor(private readonly input: PalantirRuntimeInput) {
		this.responseCollector = input.responseCollector ?? new AgentResponseCollector();
	}

	registerPlugin<TManifest extends AnyWorkflowPluginManifest>(plugin: WorkflowPlugin<TManifest>): WorkflowDispose {
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

	visibleWorkflowEntries(): RegisteredWorkflow[] {
		return this.registry.launchableEntries();
	}

	private resolvePluginImplementation<TManifest extends AnyWorkflowPluginManifest>(
		implementationInput: WorkflowPluginImplementationInput<TManifest>,
	): WorkflowPluginImplementation<TManifest> {
		return typeof implementationInput === "function"
			? implementationInput({ cwd: this.input.cwd, state: this.registrarState })
			: implementationInput;
	}

	async runWorkflow<TWorkflow extends AnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: unknown,
		options: WorkflowLaunchOptions<TWorkflow> | AnyWorkflowLaunchOptions | undefined,
	): Promise<WorkflowLaunchResult> {
		const session = await this.createRuntime(workflow, params, options);
		return this.runScheduler(session, {
			workflow,
			params,
			configOverride: options?.configOverride,
			cwd: session.runtime.cwd,
			env: options?.env ?? {},
		});
	}

	async listRunCheckpoints(path: string): Promise<WorkflowRunCheckpoint[]> {
		const runRoot = await resolveWorkflowRunRoot(this.input.cwd, path);
		return (await WorkflowRunStore.open(runRoot)).listCheckpoints();
	}

	async getActiveHumanGate(path: string): Promise<WorkflowInterruptedLaunchResult> {
		const runRoot = await resolveWorkflowRunRoot(this.input.cwd, path);
		const state = (await WorkflowRuntimeStateStore.load(runRoot)).currentState();
		if (state.status !== "interrupted") throw new Error(`Workflow run is not interrupted: ${runRoot}`);
		const current = state.current;
		if (!current) throw new Error(`Workflow run is not resumable: ${runRoot}`);
		const workflow = this.registry.workflowById(current.workflowId);
		if (!workflow) throw new Error(`Unknown workflow for interrupted run: ${current.workflowId}`);
		return interruptedLaunchResult({ id: state.id, name: state.name, workspace: state.workspace, cwd: current.cwd }, workflow, current.params, current.humanGate?.description);
	}

	async rollbackRun(path: string, checkpointId: string): Promise<WorkflowRunInfo> {
		const runRoot = await resolveWorkflowRunRoot(this.input.cwd, path);
		const lease = await WorkflowRunLease.acquire(runRoot);
		try {
			const runStore = await WorkflowRunStore.open(runRoot);
			await runStore.restoreSnapshot(checkpointId);
			return getWorkflowRunInfo(runRoot);
		} finally {
			await lease.release();
		}
	}

	async resumeWorkflow(path: string, params?: unknown): Promise<WorkflowLaunchResult> {
		const runRoot = await resolveWorkflowRunRoot(this.input.cwd, path);
		const initialStateStore = await WorkflowRuntimeStateStore.load(runRoot);
		const initialState = initialStateStore.currentState();
		if (initialState.status === "completed") throw new Error(`Workflow run is already completed: ${runRoot}`);
		if (initialState.status === "interrupted" && params === undefined) throw new Error(`Interrupted workflow resume requires params: ${runRoot}`);

		const lease = await WorkflowRunLease.acquire(runRoot);
		let isLeaseOwnedByScheduler = false;
		try {
			if (initialState.status === "running") await (await WorkflowRunStore.open(runRoot)).restoreCurrentSnapshot();
			const session = await this.openRuntime(runRoot, lease);
			const state = session.state.currentState();
			const current = state.current;
			if (!current) throw new Error(`Workflow run is not resumable: ${runRoot}`);
			const workflow = this.registry.workflowById(current.workflowId);
			if (!workflow) throw new Error(`Unknown workflow for resumed run: ${current.workflowId}`);
			if (state.status === "interrupted") {
				await session.state.replaceCurrentParams(workflow.params.parse(params));
				const resumedCurrent = session.state.currentState().current;
				if (!resumedCurrent) throw new Error(`Workflow run is not resumable: ${runRoot}`);
				isLeaseOwnedByScheduler = true;
				return this.runScheduler(session, toWorkflowStep(workflow, resumedCurrent));
			}
			isLeaseOwnedByScheduler = true;
			return this.runScheduler(session, toWorkflowStep(workflow, current));
		} finally {
			if (!isLeaseOwnedByScheduler) await lease.release();
		}
	}

	private async runScheduler(session: WorkflowRuntimeSession, initialStep: WorkflowStep): Promise<WorkflowLaunchResult> {
		let currentStep = initialStep;
		try {
			for (let step = 1; step <= 1_000; step++) {
				throwIfWorkflowRunAborted(session.activeRun);
				const stepRuntime = session.runtime.with({ cwd: currentStep.cwd, env: currentStep.env });
				if (shouldPauseForHumanGate(currentStep)) {
					const parsedParams = currentStep.workflow.params.parse(currentStep.params);
					const description = await this.registry.describeHumanGate(currentStep.workflow, stepRuntime, parsedParams, currentStep.configOverride);
					await session.state.interruptCurrent(parsedParams, description);
					await recordRuntimeEvent(session, { type: "run.interrupted", workflowId: currentStep.workflow.id });
					await commitRuntimeBoundary(session, `run interrupted: ${currentStep.workflow.id}`);
					return interruptedLaunchResult({ id: stepRuntime.id, name: session.state.currentState().name, workspace: stepRuntime.workspace, cwd: stepRuntime.cwd }, currentStep.workflow, parsedParams, description);
				}
				await session.state.startStep(toRuntimeStateStep(currentStep));
				const stepResult = await this.executeWorkflowStep(session, currentStep, stepRuntime);
				throwIfWorkflowRunAborted(session.activeRun);
				if (stepResult.type === "complete") {
					await session.state.completeRun(stepResult.workflow.id, stepResult.metadata);
					await recordRuntimeEvent(session, { type: "run.completed", workflowId: stepResult.workflow.id, metadata: stepResult.metadata });
					await commitRuntimeBoundary(session, `run completed: ${stepResult.workflow.id}`);
					return { status: "completed", id: stepRuntime.id, name: session.state.currentState().name, workspace: stepRuntime.workspace, cwd: stepRuntime.cwd, workflowId: stepResult.workflow.id, metadata: stepResult.metadata };
				}
				if (stepResult.type === "fail") {
					await session.state.failRun(stepResult.workflow.id, stepResult.metadata);
					await recordRuntimeEvent(session, { type: "run.failed", workflowId: stepResult.workflow.id, metadata: stepResult.metadata });
					await commitRuntimeBoundary(session, `run failed: ${stepResult.workflow.id}`);
					return { status: "failed", id: stepRuntime.id, name: session.state.currentState().name, workspace: stepRuntime.workspace, cwd: stepRuntime.cwd, workflowId: stepResult.workflow.id, metadata: stepResult.metadata };
				}
				const nextStep = this.nextWorkflowStep(stepResult, stepRuntime);
				await session.state.completeWithNext(currentStep.workflow.id, toRuntimeStateStep(nextStep));
				await recordRuntimeEvent(session, { type: "run.transitioned", fromWorkflowId: currentStep.workflow.id, toWorkflowId: nextStep.workflow.id });
				await commitRuntimeBoundary(session, `transition: ${currentStep.workflow.id} -> ${nextStep.workflow.id}`);
				currentStep = nextStep;
			}
			throw new Error("Workflow run exceeded 1000 scheduler steps");
		} catch (error) {
			await session.state.failCurrent(errorMessage(error));
			await recordRuntimeEvent(session, { type: "run.failed", workflowId: currentStep.workflow.id, error: errorMessage(error) });
			await commitRuntimeBoundary(session, `run failed: ${currentStep.workflow.id}`);
			throw error;
		} finally {
			await session.lease.release();
			this.finishActiveRun(session.runRoot, session.activeRun);
		}
	}

	private async executeWorkflowStep(session: WorkflowRuntimeSession, step: WorkflowStep, runtime: WorkflowRuntime): Promise<WorkflowStepResult> {
		const boundaryRef = await session.runStore.currentSnapshotRef();
		const logBoundary = session.logger.boundary();
		try {
			await assertWorkspaceBoundary(session, runtime.workspace);
			await recordRuntimeEvent(session, { type: "workflow.started", workflowId: step.workflow.id });
			const result = await this.registry.execute(step.workflow, runtime, step.params, step.configOverride);
			await assertWorkspaceBoundary(session, runtime.workspace);
			if (result.type === "complete") await recordRuntimeEvent(session, { type: "workflow.completed", workflowId: result.workflow.id, metadata: result.metadata });
			else if (result.type === "fail") await recordRuntimeEvent(session, { type: "workflow.failed", workflowId: result.workflow.id, metadata: result.metadata });
			else await recordRuntimeEvent(session, { type: "workflow.transitioned", fromWorkflowId: step.workflow.id, toWorkflowId: result.workflowId });
			return result;
		} catch (error) {
			await rollbackRuntimeBoundary(session, boundaryRef);
			rollbackRuntimeLogBoundary(session, logBoundary);
			await recordRuntimeEvent(session, { type: "workflow.failed", workflowId: step.workflow.id, error: errorMessage(error) });
			throw error;
		}
	}

	private nextWorkflowStep(next: WorkflowNext, runtime: WorkflowRuntime): WorkflowStep {
		const workflow = this.registry.workflowById(next.workflowId);
		if (!workflow) throw new Error(`Unknown next workflow: ${next.workflowId}`);
		return {
			workflow,
			params: next.params,
			configOverride: next.configOverride,
			cwd: next.cwd ?? runtime.cwd,
			env: next.env ?? {},
			humanGate: this.input.humanGateMode === "pause" && workflow.humanGate ? { status: "pending" } : undefined,
		};
	}

	private async createRuntime<TWorkflow extends AnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: unknown,
		options: WorkflowLaunchOptions<TWorkflow> | AnyWorkflowLaunchOptions | undefined,
	): Promise<WorkflowRuntimeSession> {
		const id = options?.id ?? randomUUID();
		const name = options?.name ?? id;
		const runRoot = defaultRunRoot(this.input.cwd, id);
		const currentRoot = workflowRunCurrentRoot(runRoot);
		const workspace = join(currentRoot, "workspace");
		const cwd = options?.cwd ? resolveFromWorkspace(workspace, options.cwd) : workspace;
		const startedAt = new Date().toISOString();
		await mkdir(runRoot, { recursive: true });
		const lease = await WorkflowRunLease.acquire(runRoot);
		const activeRun = this.startActiveRun(runRoot);
		try {
			const runStore = await WorkflowRunStore.initialize(runRoot);
			await mkdir(workspace, { recursive: true });
			const logger = new WorkflowRunLogger(join(currentRoot, MANIFEST_FILE_NAME), {
				id,
				name,
				workflowId: workflow.id,
				runRoot,
				workspace,
				initialCwd: cwd,
				startedAt,
			});
			const runtime = await this.buildRuntime({ id, currentRoot, workspace, cwd, env: options?.env ?? {}, signal: activeRun.controller.signal, logger });
			const state = await WorkflowRuntimeStateStore.create(runRoot, {
				id,
				name,
				rootWorkflowId: workflow.id,
				workspace,
				current: { workflowId: workflow.id, params, configOverride: options?.configOverride, cwd, env: options?.env ?? {} },
				startedAt,
			});
			const session = { runRoot, runtime, state, lease, runStore, logger, activeRun };
			await logger.record({ type: "run.started", workflowId: workflow.id, cwd, workspace });
			await commitRuntimeBoundary(session, `run started: ${workflow.id}`);
			return session;
		} catch (error) {
			await lease.release();
			this.failActiveRun(runRoot, activeRun);
			throw error;
		}
	}

	private async openRuntime(runRoot: string, lease: WorkflowRunLease): Promise<WorkflowRuntimeSession> {
		const activeRun = this.startActiveRun(runRoot);
		try {
			const state = await WorkflowRuntimeStateStore.load(runRoot);
			const currentState = state.currentState();
			if (currentState.status === "completed") throw new Error(`Workflow run is already completed: ${runRoot}`);
			const runStore = await WorkflowRunStore.open(runRoot);
			const currentRoot = workflowRunCurrentRoot(runRoot);
			const logger = await WorkflowRunLogger.load(join(currentRoot, MANIFEST_FILE_NAME));
			const cwd = currentState.current?.cwd ?? currentState.workspace;
			const env = currentState.current?.env ?? {};
			const runtime = await this.buildRuntime({ id: currentState.id, currentRoot, workspace: currentState.workspace, cwd, env, signal: activeRun.controller.signal, logger });
			await logger.record({ type: "run.resumed", workflowId: currentState.current?.workflowId, cwd });
			return { runRoot, runtime, state, lease, runStore, logger, activeRun };
		} catch (error) {
			this.failActiveRun(runRoot, activeRun);
			throw error;
		}
	}

	private async buildRuntime(input: {
		readonly id: string;
		readonly currentRoot: string;
		readonly workspace: string;
		readonly cwd: string;
		readonly env: Record<string, string>;
		readonly signal: AbortSignal;
		readonly logger: WorkflowRunLogger;
	}): Promise<WorkflowRuntime> {
		const artifactsRoot = join(input.currentRoot, "artifacts");
		const logsRoot = join(input.currentRoot, "logs");
		await mkdir(input.workspace, { recursive: true });
		await mkdir(artifactsRoot, { recursive: true });
		await mkdir(logsRoot, { recursive: true });
		return new DefaultWorkflowRuntime({
			id: input.id,
			runRoot: input.currentRoot,
			workspace: input.workspace,
			cwd: input.cwd,
			env: input.env,
			signal: input.signal,
			agentDir: this.input.agentDir,
			responseCollector: this.responseCollector,
			state: new JsonWorkflowState(join(input.currentRoot, STATE_FILE_NAME)),
			logger: input.logger,
			artifacts: new WorkflowArtifacts(artifactsRoot),
			logs: new WorkflowRunLogs(logsRoot),
		});
	}

	private startActiveRun(runRoot: string): ActiveWorkflowRun {
		if (this.activeRuns.has(runRoot)) throw new Error(`Workflow run is already active in this runtime: ${runRoot}`);
		const controller = new AbortController();
		let finish: () => void;
		const finished = new Promise<void>((resolvePromise) => {
			finish = resolvePromise;
		});
		const abortFromParent = () => controller.abort(this.input.signal?.reason);
		if (this.input.signal?.aborted) abortFromParent();
		else this.input.signal?.addEventListener("abort", abortFromParent, { once: true });
		const activeRun: ActiveWorkflowRun = {
			controller,
			finished,
			finish: () => finish(),
			dispose: () => this.input.signal?.removeEventListener("abort", abortFromParent),
		};
		this.activeRuns.set(runRoot, activeRun);
		return activeRun;
	}

	private finishActiveRun(runRoot: string, activeRun: ActiveWorkflowRun): void {
		if (this.activeRuns.get(runRoot) !== activeRun) return;
		this.activeRuns.delete(runRoot);
		activeRun.dispose();
		activeRun.finish();
	}

	private failActiveRun(runRoot: string, activeRun: ActiveWorkflowRun): void {
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

function toWorkflowStep(workflow: AnyWorkflowDeclaration, step: NonNullable<WorkflowRuntimeState["current"]>): WorkflowStep {
	return {
		workflow,
		params: step.params,
		configOverride: step.configOverride,
		cwd: step.cwd,
		env: step.env,
		humanGate: step.humanGate,
	};
}

function toRuntimeStateStep(step: WorkflowStep): NonNullable<WorkflowRuntimeState["current"]> {
	return {
		workflowId: step.workflow.id,
		params: step.params,
		configOverride: step.configOverride,
		cwd: step.cwd,
		env: step.env,
		humanGate: step.humanGate,
	};
}

function shouldPauseForHumanGate(step: WorkflowStep): boolean {
	return step.humanGate?.status === "pending" && step.workflow.humanGate !== undefined;
}

function throwIfWorkflowRunAborted(activeRun: ActiveWorkflowRun): void {
	if (!activeRun.controller.signal.aborted) return;
	const reason: unknown = activeRun.controller.signal.reason;
	if (reason instanceof Error) throw reason;
	throw new Error(typeof reason === "string" && reason.length > 0 ? reason : "Workflow run aborted");
}

function interruptedLaunchResult(runtime: WorkflowRunIdentity, workflow: AnyWorkflowDeclaration, params: unknown, description: string | undefined): WorkflowInterruptedLaunchResult {
	if (!workflow.humanGate) throw new Error(`Workflow is not human-gated: ${workflow.id}`);
	if (!description) throw new Error(`Interrupted workflow is missing human gate description: ${workflow.id}`);
	return {
		status: "interrupted",
		id: runtime.id,
		name: runtime.name,
		workspace: runtime.workspace,
		cwd: runtime.cwd,
		workflowId: workflow.id,
		params,
		humanGate: { description, fields: workflow.humanGate.fields },
	};
}

type WorkflowRunIdentity = {
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
};

async function recordRuntimeEvent(
	session: WorkflowRuntimeSession,
	event: { readonly type: string; readonly [key: string]: unknown },
): Promise<void> {
	await session.logger.record(event);
}

async function commitRuntimeBoundary(session: WorkflowRuntimeSession, message: string): Promise<void> {
	await session.lease.assertOwned();
	await session.runStore.snapshotCurrent(message);
}

async function rollbackRuntimeBoundary(session: WorkflowRuntimeSession, ref: string): Promise<void> {
	await session.lease.assertOwned();
	await session.runStore.restoreSnapshot(ref);
}

function rollbackRuntimeLogBoundary(session: WorkflowRuntimeSession, boundary: number): void {
	session.logger.rollback(boundary);
}

async function assertWorkspaceBoundary(session: WorkflowRuntimeSession, workspace: string): Promise<void> {
	await session.lease.assertOwned();
	await session.runStore.assertWorkspaceCanBeSnapshotted(workspace);
}
