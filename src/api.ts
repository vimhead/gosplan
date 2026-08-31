import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { PalantirResolvedSeerModeConfig } from "./seer/config.ts";

const WORKFLOW_DECLARATION_KIND = "palantir.workflow";

export type MaybePromise<T> = T | Promise<T>;
export type PalantirDispose = () => void;

export type PalantirWorkflowAnyGate = {
	readonly enabled: true;
	readonly fields?: readonly string[];
};

export type PalantirWorkflowDeclaration<
	Id extends string = string,
	ParamsSchema extends z.ZodType = z.ZodType,
> = {
	readonly kind: typeof WORKFLOW_DECLARATION_KIND;
	readonly id: Id;
	readonly title?: string;
	readonly isEntrypoint: boolean;
	readonly description?: string;
	readonly params: ParamsSchema;
	readonly gate?: PalantirWorkflowAnyGate;
};

export type PalantirAnyWorkflowDeclaration = PalantirWorkflowDeclaration<string, z.ZodType>;

export type PalantirWorkflowParamsInput<TWorkflow extends PalantirAnyWorkflowDeclaration> = z.input<TWorkflow["params"]>;
export type PalantirWorkflowParams<TWorkflow extends PalantirAnyWorkflowDeclaration> = z.output<TWorkflow["params"]>;

export type PalantirWorkflowGate<ParamsSchema extends z.ZodType> = unknown extends z.input<ParamsSchema>
	? PalantirWorkflowAnyGate
	: z.input<ParamsSchema> extends Record<string, unknown>
		? {
			readonly enabled: true;
			readonly fields?: readonly Extract<keyof z.input<ParamsSchema>, string>[];
		}
		: {
			readonly enabled: true;
			readonly fields?: never;
		};

export type PalantirWorkflowDefinition<
	Id extends string | undefined = string | undefined,
	ParamsSchema extends z.ZodType = z.ZodType,
> = {
	readonly id?: Id;
	readonly title?: string;
	readonly isEntrypoint: boolean;
	readonly description?: string;
	readonly params: ParamsSchema;
	readonly gate?: PalantirWorkflowGate<ParamsSchema>;
};

export type PalantirAnyWorkflowDefinition = {
	readonly id?: string;
	readonly title?: string;
	readonly isEntrypoint: boolean;
	readonly description?: string;
	readonly params: z.ZodType;
	readonly gate?: PalantirWorkflowAnyGate;
};

export type PalantirWorkflowStateDefinition<T = unknown, Id extends string = string> = {
	readonly id: Id;
	readonly description?: string;
	readonly schema: z.ZodType<T>;
};

export type PalantirWorkflowStateDefinitionInput<T = unknown, Id extends string | undefined = string | undefined> = {
	readonly id?: Id;
	readonly description?: string;
	readonly schema: z.ZodType<T>;
};

export type PalantirWorkflowPluginWorkflows = Record<string, PalantirAnyWorkflowDefinition>;
export type PalantirWorkflowPluginStateTree = { readonly [key: string]: PalantirWorkflowPluginStateTreeNode };
export type PalantirWorkflowPluginStateTreeNode = z.ZodType | PalantirWorkflowStateDefinitionInput | PalantirWorkflowPluginStateTree;

type JoinPath<Head extends string, Parts extends readonly string[]> = Parts extends readonly []
	? Head
	: Parts extends readonly [infer First extends string, ...infer Rest extends string[]]
		? JoinPath<`${Head}.${First}`, Rest>
		: string;

type PalantirInvalidGateFields<TWorkflow> = TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType; readonly gate: { readonly fields: infer Fields extends readonly string[] } }
	? Exclude<Fields[number], Extract<keyof z.input<ParamsSchema>, string>>
	: never;

type PalantirValidatedWorkflowGate<TWorkflow> = [PalantirInvalidGateFields<TWorkflow>] extends [never]
	? unknown
	: { readonly gate: { readonly fields: readonly Extract<keyof z.input<TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType } ? ParamsSchema : z.ZodType>, string>[] } };

export type PalantirValidatedWorkflowGates<Workflows> = {
	readonly [Key in keyof Workflows]: PalantirValidatedWorkflowGate<Workflows[Key]>;
};

export type PalantirQualifiedPluginWorkflow<
	PluginId extends string,
	WorkflowKey extends string,
	TWorkflow extends PalantirAnyWorkflowDefinition,
> = TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType }
	? PalantirWorkflowDeclaration<
		TWorkflow extends { readonly id: infer ExplicitId extends string } ? ExplicitId : `${PluginId}.${WorkflowKey}`,
		ParamsSchema
	>
	: never;

export type PalantirQualifiedPluginWorkflows<PluginId extends string, Workflows extends PalantirWorkflowPluginWorkflows> = {
	readonly [Key in keyof Workflows]: PalantirQualifiedPluginWorkflow<PluginId, Key & string, Workflows[Key]>;
};

export type PalantirQualifiedPluginStates<PluginId extends string, States, Path extends readonly string[] = []> = {
	readonly [Key in keyof States]: States[Key] extends z.ZodType
		? PalantirWorkflowStateDefinition<z.output<States[Key]>, JoinPath<PluginId, [...Path, Key & string]>>
		: States[Key] extends PalantirWorkflowStateDefinitionInput<infer Value>
			? PalantirWorkflowStateDefinition<
				Value,
				States[Key] extends { readonly id: infer ExplicitId extends string } ? ExplicitId : JoinPath<PluginId, [...Path, Key & string]>
			>
			: States[Key] extends PalantirWorkflowPluginStateTree
				? PalantirQualifiedPluginStates<PluginId, States[Key], [...Path, Key & string]>
				: never;
};

export type PalantirWorkflowPluginManifest<
	PluginId extends string = string,
	ConfigSchema extends z.ZodType | undefined = z.ZodType | undefined,
	Workflows extends Record<string, PalantirAnyWorkflowDeclaration> = Record<string, PalantirAnyWorkflowDeclaration>,
	States = undefined,
> = {
	readonly id: PluginId;
	readonly config?: ConfigSchema;
	readonly workflows: Workflows;
	readonly states: States;
};

export type PalantirAnyWorkflowPluginManifest = PalantirWorkflowPluginManifest<string, z.ZodType | undefined, Record<string, PalantirAnyWorkflowDeclaration>, unknown>;

export type PalantirWorkflowPluginConfigSchema<TManifest extends PalantirAnyWorkflowPluginManifest> = TManifest extends { readonly config?: infer ConfigSchema extends z.ZodType | undefined }
	? ConfigSchema
	: undefined;

export type PalantirWorkflowPluginConfig<TManifest extends PalantirAnyWorkflowPluginManifest> = NonNullable<PalantirWorkflowPluginConfigSchema<TManifest>> extends z.ZodType
	? z.output<NonNullable<PalantirWorkflowPluginConfigSchema<TManifest>>>
	: undefined;

export type PalantirDefinePluginManifestInput<
	PluginId extends string,
	ConfigSchema extends z.ZodType | undefined,
	Workflows extends PalantirWorkflowPluginWorkflows,
	States extends PalantirWorkflowPluginStateTree | undefined,
> = {
	readonly id: PluginId;
	readonly config?: ConfigSchema;
	readonly workflows: Workflows & PalantirValidatedWorkflowGates<Workflows>;
	readonly states?: States;
};

export function definePluginManifest<
	const PluginId extends string,
	const ConfigSchema extends z.ZodType | undefined = undefined,
	const Workflows extends PalantirWorkflowPluginWorkflows = PalantirWorkflowPluginWorkflows,
	const States extends PalantirWorkflowPluginStateTree | undefined = undefined,
>(
	input: PalantirDefinePluginManifestInput<PluginId, ConfigSchema, Workflows, States>,
): PalantirWorkflowPluginManifest<
	PluginId,
	ConfigSchema,
	PalantirQualifiedPluginWorkflows<PluginId, Workflows>,
	States extends PalantirWorkflowPluginStateTree ? PalantirQualifiedPluginStates<PluginId, States> : undefined
> {
	assertLocalDeclarationId(input.id, "plugin");
	const declaredIds = new Set<string>();
	const workflows = Object.fromEntries(
		Object.entries(input.workflows).map(([key, workflow]) => [key, qualifyWorkflow(input.id, key, workflow, declaredIds)]),
	) as PalantirQualifiedPluginWorkflows<PluginId, Workflows>;
	return {
		id: input.id,
		config: input.config,
		workflows,
		states: qualifyStateTree(input.id, input.states, [], declaredIds) as States extends PalantirWorkflowPluginStateTree ? PalantirQualifiedPluginStates<PluginId, States> : undefined,
	};
}

export type PalantirRunNext = {
	readonly type: "next";
	readonly workflowId: string;
	readonly params: unknown;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
};

export type PalantirRunOutcomeMetadata = {
	readonly summary?: string;
	readonly artifacts?: Record<string, PalantirWorkflowArtifactRef>;
	readonly logs?: Record<string, PalantirLogRef>;
	readonly data?: Record<string, unknown>;
};

export type PalantirRunComplete = {
	readonly type: "complete";
	readonly metadata?: PalantirRunOutcomeMetadata;
};

export type PalantirRunFail = {
	readonly type: "fail";
	readonly metadata: PalantirRunOutcomeMetadata & { readonly summary: string };
};

export type PalantirWorkflowExecutionResult = PalantirRunNext | PalantirRunComplete | PalantirRunFail;

export type PalantirWorkflowGateImplementation<TWorkflow extends PalantirAnyWorkflowDeclaration, TConfig> = {
	describe(
		run: PalantirRun,
		params: PalantirWorkflowParams<TWorkflow>,
		config: TConfig,
	): MaybePromise<string>;
};

export type PalantirWorkflowImplementation<TWorkflow extends PalantirAnyWorkflowDeclaration, TConfig = unknown> = {
	readonly gate?: PalantirWorkflowGateImplementation<TWorkflow, TConfig>;
	execute(
		run: PalantirRun,
		params: PalantirWorkflowParams<TWorkflow>,
		config: TConfig,
	): MaybePromise<PalantirWorkflowExecutionResult>;
};

export type PalantirRunStartOptions = {
	readonly id?: string;
	readonly name?: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly configOverride?: unknown;
};

export type PalantirStartedRunResult = {
	readonly status: "running";
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
};

export type PalantirCompletedRunResult = {
	readonly status: "completed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata?: PalantirRunOutcomeMetadata;
};

export type PalantirFailedRunResult = {
	readonly status: "failed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata: PalantirRunOutcomeMetadata & { readonly summary: string };
};

export type PalantirRunInterruption = {
	readonly workflowId: string;
	readonly params: unknown;
	readonly description: string;
	readonly fields?: readonly string[];
};

export type PalantirInterruptedRunResult = {
	readonly status: "interrupted";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly interruption: PalantirRunInterruption;
};

export type PalantirRunResult = PalantirStartedRunResult | PalantirCompletedRunResult | PalantirFailedRunResult | PalantirInterruptedRunResult;

export type PalantirRunStatus = "running" | "interrupted" | "completed" | "failed";
export type PalantirRunHealth = "healthy" | "unhealthy";

export type PalantirRunOutcomeInfo = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly status: "completed" | "failed";
	readonly metadata?: PalantirRunOutcomeMetadata;
};

export type PalantirRunFailureInfo = {
	readonly workflowId: string;
	readonly error: string;
	readonly metadata?: PalantirRunOutcomeMetadata;
	readonly failedAt: string;
};

export type PalantirRunInfo = {
	readonly version: number;
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly entrypointWorkflowId: string;
	readonly currentWorkflowId?: string;
	readonly status: PalantirRunStatus;
	readonly health: PalantirRunHealth;
	readonly interruption?: PalantirRunInterruption;
	readonly outcome?: PalantirRunOutcomeInfo;
	readonly failed?: PalantirRunFailureInfo;
	readonly startedAt: string;
	readonly updatedAt: string;
};

export type DeletedPalantirRunInfo = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
};

export type PalantirRunCheckpoint = {
	readonly id: string;
	readonly path: string;
	readonly index: number;
	readonly message: string;
	readonly createdAt: string;
};

export type PalantirWorkflowStateReader = {
	get<T>(state: PalantirWorkflowStateDefinition<T>): Promise<T>;
	getOptional<T>(state: PalantirWorkflowStateDefinition<T>): Promise<T | undefined>;
};

export type PalantirWorkflowState = PalantirWorkflowStateReader & {
	set<T>(state: PalantirWorkflowStateDefinition<T>, value: T): Promise<void>;
};

export type PalantirWorkflowPluginContext = {
	readonly cwd: string;
	readonly state: PalantirWorkflowState;
};

export type PalantirWorkflowPluginImplementation<TManifest extends PalantirAnyWorkflowPluginManifest> = {
	readonly workflows: {
		readonly [Key in keyof TManifest["workflows"]]: PalantirWorkflowImplementation<TManifest["workflows"][Key], PalantirWorkflowPluginConfig<TManifest>>;
	};
};

export type PalantirWorkflowPluginImplementationFactory<TManifest extends PalantirAnyWorkflowPluginManifest> = (
	context: PalantirWorkflowPluginContext,
) => PalantirWorkflowPluginImplementation<TManifest>;

export type PalantirWorkflowPluginImplementationInput<TManifest extends PalantirAnyWorkflowPluginManifest> =
	| PalantirWorkflowPluginImplementation<TManifest>
	| PalantirWorkflowPluginImplementationFactory<TManifest>;

export type PalantirWorkflowPlugin<TManifest extends PalantirAnyWorkflowPluginManifest = PalantirAnyWorkflowPluginManifest> = {
	readonly manifest: TManifest;
	readonly implementation: PalantirWorkflowPluginImplementationInput<TManifest>;
};

export function definePlugin<TManifest extends PalantirAnyWorkflowPluginManifest>(
	manifest: TManifest,
	implementation: PalantirWorkflowPluginImplementationInput<TManifest>,
): PalantirWorkflowPlugin<TManifest> {
	return { manifest, implementation };
}

export type PalantirCommandRunInput = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs?: number;
};

export const workflowArtifactRefSchema = z.object({
	path: z.string(),
});

export type PalantirWorkflowArtifactRef = z.output<typeof workflowArtifactRefSchema>;

export type PalantirLogRef = {
	readonly id: string;
};

export type PalantirCommandRunResult = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd: string;
	readonly exitCode: number | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
	readonly killed: boolean;
	readonly stdoutLog: PalantirLogRef;
	readonly stderrLog: PalantirLogRef;
};

export type PalantirAgentInitialEvent = {
	readonly name: string;
	readonly data?: unknown;
};

export type PalantirAgentSpawnInput = {
	readonly label: string;
	readonly cwd?: string;
	readonly tools?: string[];
	readonly initialEvents?: readonly PalantirAgentInitialEvent[];
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
};

export type PalantirAgentPromptInput<ResponseSchema extends z.ZodType> = {
	readonly prompt: string;
	readonly response: ResponseSchema;
	readonly maxAttempts?: number;
};

export type PalantirAgentRunInput<ResponseSchema extends z.ZodType> = PalantirAgentSpawnInput & PalantirAgentPromptInput<ResponseSchema>;

export type PalantirAgentSessionEvents = {
	emit(name: string, data?: unknown): void;
	on(name: string, handler: (data: unknown) => void): PalantirDispose;
};

export type PalantirAgentUsageCost = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
};

export type PalantirAgentUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly cost: PalantirAgentUsageCost;
};

export type PalantirAgentMetrics = {
	readonly index: number;
	readonly label: string;
	readonly status: "running" | "completed" | "failed";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly attempts?: number;
	readonly usage: PalantirAgentUsage;
};

export type PalantirCommandMetrics = {
	readonly index: number;
	readonly label: string;
	readonly status: "running" | "completed" | "failed";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly exitCode?: number | null;
	readonly killed?: boolean;
};

export type PalantirWorkflowMetrics = {
	readonly index: number;
	readonly workflowId: string;
	readonly status: "running" | "completed" | "failed" | "transitioned";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly ownMs: number;
	readonly agentsMs: number;
	readonly commandsMs: number;
	readonly agentUsage: PalantirAgentUsage;
	readonly agents: readonly PalantirAgentMetrics[];
	readonly commands: readonly PalantirCommandMetrics[];
};

export type PalantirRunMetrics = {
	readonly status: PalantirRunStatus;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly activeMs: number;
	readonly gateWaitMs: number;
	readonly workflowsMs: number;
	readonly workflowOwnMs: number;
	readonly agentsMs: number;
	readonly commandsMs: number;
	readonly agentUsage: PalantirAgentUsage;
	readonly workflows: readonly PalantirWorkflowMetrics[];
};

export type PalantirAgentRunRawAttempt = {
	readonly attempt: number;
	readonly text: string;
	readonly messages: unknown[];
	readonly responseToolCalled: boolean;
	readonly usage: PalantirAgentUsage;
	readonly toolResponse?: unknown;
	readonly sessionFile?: string;
	readonly error?: string;
};

export type PalantirAgentRunResult<ResponseSchema extends z.ZodType> = {
	readonly label: string;
	readonly cwd: string;
	readonly response: z.output<ResponseSchema>;
	readonly usage: PalantirAgentUsage;
	readonly raw: {
		readonly text: string;
		readonly messages: unknown[];
		readonly responseToolCalled: boolean;
		readonly usage: PalantirAgentUsage;
		readonly toolResponse?: unknown;
		readonly sessionFile?: string;
		readonly attempts: readonly PalantirAgentRunRawAttempt[];
	};
};

export type PalantirAgentSession = {
	readonly label: string;
	readonly cwd: string;
	readonly events: PalantirAgentSessionEvents;
	run<ResponseSchema extends z.ZodType>(input: PalantirAgentPromptInput<ResponseSchema>): Promise<PalantirAgentRunResult<ResponseSchema>>;
	dispose(): Promise<void>;
};

export type PalantirRun = {
	id: string;
	workspace: string;
	cwd: string;
	with(options: { cwd?: string; env?: Record<string, string> }): PalantirRun;
	path(relativePath: string): string;
	next<TWorkflow extends PalantirAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: PalantirWorkflowParamsInput<TWorkflow>,
	): PalantirRunNext;
	next(workflowId: string, params: unknown): PalantirRunNext;
	complete(metadata?: PalantirRunOutcomeMetadata): PalantirRunComplete;
	fail(metadata: PalantirRunOutcomeMetadata & { readonly summary: string }): PalantirRunFail;
	state: PalantirWorkflowState;
	artifacts: {
		write(path: string, content: string): Promise<PalantirWorkflowArtifactRef>;
		read(ref: PalantirWorkflowArtifactRef): Promise<string>;
	};
	logs: {
		read(log: PalantirLogRef): Promise<string>;
	};
	commands: {
		run(input: PalantirCommandRunInput): Promise<PalantirCommandRunResult>;
	};
	agents: {
		spawn(input: PalantirAgentSpawnInput): Promise<PalantirAgentSession>;
		run<ResponseSchema extends z.ZodType>(input: PalantirAgentRunInput<ResponseSchema>): Promise<PalantirAgentRunResult<ResponseSchema>>;
	};
};

export type PalantirWorkflowPluginInfo = {
	readonly id: string;
	readonly path?: string;
	readonly configPath?: string;
};

export type PalantirJsonSchema = Record<string, unknown>;

export type PalantirWorkflowGateInfo = {
	readonly enabled: true;
	readonly fields?: readonly string[];
};

export type PalantirRegisteredWorkflowInfo = {
	readonly id: string;
	readonly title: string | null;
	readonly description?: string;
	readonly isEntrypoint: boolean;
	readonly plugin?: PalantirWorkflowPluginInfo;
};

export type PalantirInspectedWorkflowInfo = PalantirRegisteredWorkflowInfo & {
	readonly paramsSchema: PalantirJsonSchema;
	readonly gate: PalantirWorkflowGateInfo | null;
};

export type PalantirProjectPluginInfo = PalantirWorkflowPluginInfo & {
	readonly configSchema: PalantirJsonSchema | null;
	readonly config: unknown;
};

export type PalantirProjectInfo = {
	readonly cwd: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly configFiles: readonly string[];
	readonly plugins: readonly PalantirProjectPluginInfo[];
	readonly seerMode: PalantirResolvedSeerModeConfig | null;
};

function assertLocalDeclarationId(id: string, kind: "plugin" | "workflow" | "state"): void {
	if (id.length === 0) throw new Error(`Workflow ${kind} id must not be empty`);
	if (id.includes(".")) throw new Error(`Workflow ${kind} id must not contain dots: ${id}`);
}

function resolveDeclarationId(pluginId: string, path: readonly string[], explicitId: string | undefined, kind: "workflow" | "state", declaredIds: Set<string>): string {
	for (const segment of path) assertLocalDeclarationId(segment, kind);
	const id = explicitId ?? [pluginId, ...path].join(".");
	if (explicitId !== undefined) assertPluginQualifiedId(pluginId, explicitId, kind);
	if (declaredIds.has(id)) throw new Error(`Duplicate Palantir ${kind} id: ${id}`);
	declaredIds.add(id);
	return id;
}

function assertPluginQualifiedId(pluginId: string, id: string, kind: "workflow" | "state"): void {
	if (!id.startsWith(`${pluginId}.`)) throw new Error(`Explicit Palantir ${kind} id must start with ${pluginId}.: ${id}`);
	if (id.length === pluginId.length + 1) throw new Error(`Explicit Palantir ${kind} id must not be empty after ${pluginId}.`);
}

function qualifyWorkflow<PluginId extends string, TWorkflow extends PalantirAnyWorkflowDefinition>(
	pluginId: PluginId,
	key: string,
	workflow: TWorkflow,
	declaredIds: Set<string>,
): PalantirQualifiedPluginWorkflow<PluginId, string, TWorkflow> {
	const id = resolveDeclarationId(pluginId, [key], workflow.id, "workflow", declaredIds);
	return { kind: WORKFLOW_DECLARATION_KIND, ...workflow, id } as unknown as PalantirQualifiedPluginWorkflow<PluginId, string, TWorkflow>;
}

function qualifyStateTree(pluginId: string, node: PalantirWorkflowPluginStateTreeNode | undefined, path: readonly string[], declaredIds: Set<string>): unknown {
	if (!node) return undefined;
	if (isZodSchema(node)) return { id: resolveDeclarationId(pluginId, path, undefined, "state", declaredIds), schema: node };
	if (isWorkflowStateDefinitionInput(node)) {
		return { ...node, id: resolveDeclarationId(pluginId, path, node.id, "state", declaredIds) };
	}
	return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, qualifyStateTree(pluginId, child, [...path, key], declaredIds)]));
}

export function isWorkflowDeclaration(value: unknown): value is PalantirAnyWorkflowDeclaration {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { kind?: unknown; id?: unknown; title?: unknown; isEntrypoint?: unknown; params?: unknown };
	return (
		candidate.kind === WORKFLOW_DECLARATION_KIND &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		(candidate.title === undefined || typeof candidate.title === "string") &&
		typeof candidate.isEntrypoint === "boolean" &&
		Boolean(candidate.params)
	);
}

function isWorkflowStateDefinitionInput(value: unknown): value is PalantirWorkflowStateDefinitionInput<unknown> {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { id?: unknown; schema?: unknown };
	return (candidate.id === undefined || typeof candidate.id === "string") && isZodSchema(candidate.schema);
}

function isZodSchema(value: unknown): value is z.ZodType {
	return Boolean(value && typeof value === "object" && typeof (value as { safeParse?: unknown }).safeParse === "function");
}

export function isWorkflowPlugin(value: unknown): value is PalantirWorkflowPlugin {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { manifest?: unknown; implementation?: unknown };
	return isWorkflowPluginManifest(candidate.manifest) && Boolean(candidate.implementation);
}

export function isWorkflowPluginManifest(value: unknown): value is PalantirAnyWorkflowPluginManifest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { id?: unknown; workflows?: unknown };
	if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
	if (!candidate.workflows || typeof candidate.workflows !== "object") return false;
	return Object.values(candidate.workflows).every(isWorkflowDeclaration);
}

export function isWorkflowNext(value: unknown): value is PalantirRunNext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; workflowId?: unknown; params?: unknown };
	return candidate.type === "next" && typeof candidate.workflowId === "string" && candidate.workflowId.length > 0;
}

export function isWorkflowComplete(value: unknown): value is PalantirRunComplete {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown };
	return candidate.type === "complete";
}

export function isWorkflowFail(value: unknown): value is PalantirRunFail {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; metadata?: { summary?: unknown } };
	return candidate.type === "fail" && typeof candidate.metadata?.summary === "string" && candidate.metadata.summary.length > 0;
}
