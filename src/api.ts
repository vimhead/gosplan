import type { CreateAgentSessionOptions, EventBus, PromptOptions } from "@earendil-works/pi-coding-agent";
import { z } from "zod";
import type { NornResolvedSeerModeConfig } from "./seer/config.ts";

const WORKFLOW_DECLARATION_KIND = "norn.workflow";

export type MaybePromise<T> = T | Promise<T>;
export type NornDispose = () => void;

export type NornWorkflowAnyGate = {
	readonly enabled: true;
	readonly fields?: readonly string[];
};

export type NornWorkflowIsolationMode = "runWorkspace" | "project";

export type NornWorkflowIsolation<Mode extends NornWorkflowIsolationMode = NornWorkflowIsolationMode> = {
	readonly mode: Mode;
};

declare const nornWorkflowRefParamsBrand: unique symbol;
declare const nornWorkflowRefForwardParamsBrand: unique symbol;

type NornWorkflowRefForwardParams = Record<string, unknown> & {
	readonly [nornWorkflowRefForwardParamsBrand]: true;
};

export type NornWorkflowRef<ParamsSchema extends z.ZodType = z.ZodType, Id extends string = string, ForwardParams = unknown> = Id & {
	readonly [nornWorkflowRefParamsBrand]: (params: z.input<ParamsSchema> & ForwardParams) => z.input<ParamsSchema> & ForwardParams;
};

export type NornWorkflowDeclaration<
	Id extends string = string,
	ParamsSchema extends z.ZodType = z.ZodType,
	IsolationMode extends NornWorkflowIsolationMode = NornWorkflowIsolationMode,
> = {
	readonly kind: typeof WORKFLOW_DECLARATION_KIND;
	readonly id: NornWorkflowRef<ParamsSchema, Id>;
	readonly title?: string;
	readonly isEntrypoint: boolean;
	readonly description?: string;
	readonly params: ParamsSchema;
	readonly gate?: NornWorkflowAnyGate;
	readonly isolation: NornWorkflowIsolation<IsolationMode>;
};

export type NornAnyWorkflowDeclaration = NornWorkflowDeclaration<string, z.ZodType<any, any>>;
export type NornWorkflowTarget<ParamsSchema extends z.ZodType = z.ZodType> = NornWorkflowDeclaration<string, ParamsSchema> | NornWorkflowRef<ParamsSchema>;
export type NornWorkflowRefSchemaInput<ParamsSchema extends z.ZodType = z.ZodType> = string | {
	readonly id: NornWorkflowRef<ParamsSchema>;
	readonly workflow?: never;
	readonly forwardParams?: never;
};
export type NornWorkflowRefSchemaOptions<ParamsSchema extends z.ZodType = z.ZodType> = {
	readonly params?: ParamsSchema;
};
export type NornWorkflowRefInput<ParamsSchema extends z.ZodType> =
	| NornWorkflowRefSchemaInput<ParamsSchema>
	| {
		readonly workflow: NornWorkflowRefSchemaInput<z.ZodType<any, any>>;
		readonly forwardParams: Record<string, unknown>;
	};
export type NornWorkflowRefOutput<ParamsSchema extends z.ZodType> = {
	readonly workflow: NornWorkflowRef<ParamsSchema, string, NornWorkflowRefForwardParams>;
	readonly forwardParams: NornWorkflowRefForwardParams;
};

export type NornWorkflowParamsInput<TWorkflow extends NornAnyWorkflowDeclaration> = z.input<TWorkflow["params"]>;
export type NornWorkflowParams<TWorkflow extends NornAnyWorkflowDeclaration> = z.output<TWorkflow["params"]>;
export type NornWorkflowTargetParamsInput<TWorkflow extends NornWorkflowTarget<any>> = TWorkflow extends NornWorkflowDeclaration<string, infer ParamsSchema>
	? z.input<ParamsSchema>
	: TWorkflow extends NornWorkflowRef<infer ParamsSchema, string, infer ForwardParams>
		? z.input<ParamsSchema> & ForwardParams
		: never;

export type NornWorkflowGate<ParamsSchema extends z.ZodType> = unknown extends z.input<ParamsSchema>
	? NornWorkflowAnyGate
	: z.input<ParamsSchema> extends Record<string, unknown>
		? {
			readonly enabled: true;
			readonly fields?: readonly Extract<keyof z.input<ParamsSchema>, string>[];
		}
		: {
			readonly enabled: true;
			readonly fields?: never;
		};

export type NornWorkflowDefinition<
	Id extends string | undefined = string | undefined,
	ParamsSchema extends z.ZodType = z.ZodType,
	IsolationMode extends NornWorkflowIsolationMode = NornWorkflowIsolationMode,
> = {
	readonly id?: Id;
	readonly title?: string;
	readonly isEntrypoint: boolean;
	readonly description?: string;
	readonly params: ParamsSchema;
	readonly gate?: NornWorkflowGate<ParamsSchema>;
	readonly isolation?: NornWorkflowIsolation<IsolationMode>;
};

export type NornAnyWorkflowDefinition = {
	readonly id?: string;
	readonly title?: string;
	readonly isEntrypoint: boolean;
	readonly description?: string;
	readonly params: z.ZodType;
	readonly gate?: NornWorkflowAnyGate;
	readonly isolation?: NornWorkflowIsolation;
};

export type NornWorkflowStateDefinition<T = unknown, Id extends string = string> = {
	readonly id: Id;
	readonly description?: string;
	readonly schema: z.ZodType<T>;
};

export type NornWorkflowStateDefinitionInput<T = unknown, Id extends string | undefined = string | undefined> = {
	readonly id?: Id;
	readonly description?: string;
	readonly schema: z.ZodType<T>;
};

export type NornWorkflowPluginWorkflows = Record<string, NornAnyWorkflowDefinition>;
export type NornWorkflowPluginStateTree = { readonly [key: string]: NornWorkflowPluginStateTreeNode };
export type NornWorkflowPluginStateTreeNode = z.ZodType | NornWorkflowStateDefinitionInput | NornWorkflowPluginStateTree;

type JoinPath<Head extends string, Parts extends readonly string[]> = Parts extends readonly []
	? Head
	: Parts extends readonly [infer First extends string, ...infer Rest extends string[]]
		? JoinPath<`${Head}.${First}`, Rest>
		: string;

type NornInvalidGateFields<TWorkflow> = TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType; readonly gate: { readonly fields: infer Fields extends readonly string[] } }
	? Exclude<Fields[number], Extract<keyof z.input<ParamsSchema>, string>>
	: never;

type NornValidatedWorkflowGate<TWorkflow> = [NornInvalidGateFields<TWorkflow>] extends [never]
	? unknown
	: { readonly gate: { readonly fields: readonly Extract<keyof z.input<TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType } ? ParamsSchema : z.ZodType>, string>[] } };

export type NornValidatedWorkflowGates<Workflows> = {
	readonly [Key in keyof Workflows]: NornValidatedWorkflowGate<Workflows[Key]>;
};

export type NornQualifiedPluginWorkflow<
	PluginId extends string,
	WorkflowKey extends string,
	TWorkflow extends NornAnyWorkflowDefinition,
> = TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType }
	? NornWorkflowDeclaration<
		TWorkflow extends { readonly id: infer ExplicitId extends string } ? ExplicitId : `${PluginId}.${WorkflowKey}`,
		ParamsSchema,
		TWorkflow extends { readonly isolation: { readonly mode: infer IsolationMode extends NornWorkflowIsolationMode } } ? IsolationMode : "runWorkspace"
	>
	: never;

export type NornQualifiedPluginWorkflows<PluginId extends string, Workflows extends NornWorkflowPluginWorkflows> = {
	readonly [Key in keyof Workflows]: NornQualifiedPluginWorkflow<PluginId, Key & string, Workflows[Key]>;
};

export type NornQualifiedPluginStates<PluginId extends string, States, Path extends readonly string[] = []> = {
	readonly [Key in keyof States]: States[Key] extends z.ZodType
		? NornWorkflowStateDefinition<z.output<States[Key]>, JoinPath<PluginId, [...Path, Key & string]>>
		: States[Key] extends NornWorkflowStateDefinitionInput<infer Value>
			? NornWorkflowStateDefinition<
				Value,
				States[Key] extends { readonly id: infer ExplicitId extends string } ? ExplicitId : JoinPath<PluginId, [...Path, Key & string]>
			>
			: States[Key] extends NornWorkflowPluginStateTree
				? NornQualifiedPluginStates<PluginId, States[Key], [...Path, Key & string]>
				: never;
};

export type NornWorkflowPluginManifest<
	PluginId extends string = string,
	ConfigSchema extends z.ZodType | undefined = z.ZodType | undefined,
	Workflows extends Record<string, NornAnyWorkflowDeclaration> = Record<string, NornAnyWorkflowDeclaration>,
	States = undefined,
> = {
	readonly id: PluginId;
	readonly config?: ConfigSchema;
	readonly workflows: Workflows;
	readonly states: States;
};

export type NornAnyWorkflowPluginManifest = NornWorkflowPluginManifest<string, z.ZodType | undefined, Record<string, NornAnyWorkflowDeclaration>, unknown>;

export type NornWorkflowPluginConfigSchema<TManifest extends NornAnyWorkflowPluginManifest> = TManifest extends { readonly config?: infer ConfigSchema extends z.ZodType | undefined }
	? ConfigSchema
	: undefined;

export type NornWorkflowPluginConfig<TManifest extends NornAnyWorkflowPluginManifest> = NonNullable<NornWorkflowPluginConfigSchema<TManifest>> extends z.ZodType
	? z.output<NonNullable<NornWorkflowPluginConfigSchema<TManifest>>>
	: undefined;

export type NornDefinePluginManifestInput<
	PluginId extends string,
	ConfigSchema extends z.ZodType | undefined,
	Workflows extends NornWorkflowPluginWorkflows,
	States extends NornWorkflowPluginStateTree | undefined,
> = {
	readonly id: PluginId;
	readonly config?: ConfigSchema;
	readonly workflows: Workflows & NornValidatedWorkflowGates<Workflows>;
	readonly states?: States;
};

export function definePluginManifest<
	const PluginId extends string,
	const ConfigSchema extends z.ZodType | undefined = undefined,
	const Workflows extends NornWorkflowPluginWorkflows = NornWorkflowPluginWorkflows,
	const States extends NornWorkflowPluginStateTree | undefined = undefined,
>(
	input: NornDefinePluginManifestInput<PluginId, ConfigSchema, Workflows, States>,
): NornWorkflowPluginManifest<
	PluginId,
	ConfigSchema,
	NornQualifiedPluginWorkflows<PluginId, Workflows>,
	States extends NornWorkflowPluginStateTree ? NornQualifiedPluginStates<PluginId, States> : undefined
> {
	assertLocalDeclarationId(input.id, "plugin");
	const declaredIds = new Set<string>();
	const workflows = Object.fromEntries(
		Object.entries(input.workflows).map(([key, workflow]) => [key, qualifyWorkflow(input.id, key, workflow, declaredIds)]),
	) as NornQualifiedPluginWorkflows<PluginId, Workflows>;
	return {
		id: input.id,
		config: input.config,
		workflows,
		states: qualifyStateTree(input.id, input.states, [], declaredIds) as States extends NornWorkflowPluginStateTree ? NornQualifiedPluginStates<PluginId, States> : undefined,
	};
}

export type NornRunNext = {
	readonly type: "next";
	readonly workflowId: string;
	readonly params: unknown;
};

export type NornRunOutcomeMetadata = {
	readonly summary?: string;
	readonly artifacts?: Record<string, NornArtifactRef>;
	readonly logs?: Record<string, NornLogRef>;
	readonly data?: Record<string, unknown>;
};

export type NornRunComplete = {
	readonly type: "complete";
	readonly metadata?: NornRunOutcomeMetadata;
};

export type NornRunFail = {
	readonly type: "fail";
	readonly metadata: NornRunOutcomeMetadata & { readonly summary: string };
};

export type NornWorkflowExecutionResult = NornRunNext | NornRunComplete | NornRunFail;

export type NornRunFor<TWorkflow extends NornAnyWorkflowDeclaration> = TWorkflow extends { readonly isolation: { readonly mode: "project" } }
	? NornProjectRun
	: NornRun;

export type NornWorkflowGateImplementation<TWorkflow extends NornAnyWorkflowDeclaration, TConfig> = {
	describe(
		run: NornRunFor<TWorkflow>,
		params: NornWorkflowParams<TWorkflow>,
		config: TConfig,
	): MaybePromise<string>;
};

export type NornWorkflowImplementation<TWorkflow extends NornAnyWorkflowDeclaration, TConfig = unknown> = {
	readonly gate?: NornWorkflowGateImplementation<TWorkflow, TConfig>;
	execute(
		run: NornRunFor<TWorkflow>,
		params: NornWorkflowParams<TWorkflow>,
		config: TConfig,
	): MaybePromise<NornWorkflowExecutionResult>;
};

export type NornRunStartOptions = {
	readonly id?: string;
	readonly name?: string;
	readonly configOverride?: unknown;
};

export type NornStartedRunResult = {
	readonly status: "running";
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
};

export type NornCompletedRunResult = {
	readonly status: "completed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata?: NornRunOutcomeMetadata;
};

export type NornFailedRunResult = {
	readonly status: "failed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata: NornRunOutcomeMetadata & { readonly summary: string };
};

export type NornStoppedRunResult = {
	readonly status: "stopped";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
};

export type NornRunInterruption = {
	readonly workflowId: string;
	readonly params: unknown;
	readonly description: string;
	readonly fields?: readonly string[];
};

export type NornInterruptedRunResult = {
	readonly status: "interrupted";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly interruption: NornRunInterruption;
};

export type NornRunResult = NornStartedRunResult | NornCompletedRunResult | NornFailedRunResult | NornStoppedRunResult | NornInterruptedRunResult;

export type NornRunStatus = "running" | "interrupted" | "stopped" | "pendingResume" | "completed" | "failed";
export type NornRunHealth = "healthy" | "unhealthy";

export type NornRunOutcomeInfo = {
	readonly workflowId: string;
	readonly completedAt: string;
	readonly status: "completed" | "failed";
	readonly metadata?: NornRunOutcomeMetadata;
};

export type NornRunFailureInfo = {
	readonly workflowId: string;
	readonly error: string;
	readonly metadata?: NornRunOutcomeMetadata;
	readonly failedAt: string;
};

export type NornRunInfo = {
	readonly version: number;
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly entrypointWorkflowId: string;
	readonly currentWorkflowId?: string;
	readonly status: NornRunStatus;
	readonly health: NornRunHealth;
	readonly interruption?: NornRunInterruption;
	readonly outcome?: NornRunOutcomeInfo;
	readonly failed?: NornRunFailureInfo;
	readonly startedAt: string;
	readonly updatedAt: string;
};

export type DeletedNornRunInfo = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
};

export type NornRunCheckpoint = {
	readonly id: string;
	readonly path: string;
	readonly index: number;
	readonly message: string;
	readonly createdAt: string;
};

export type NornWorkflowStateReader = {
	get<T>(state: NornWorkflowStateDefinition<T>): Promise<T>;
	getOptional<T>(state: NornWorkflowStateDefinition<T>): Promise<T | undefined>;
};

export type NornWorkflowState = NornWorkflowStateReader & {
	set<T>(state: NornWorkflowStateDefinition<T>, value: T): Promise<void>;
};

export type NornWorkflowPluginContext = {
	readonly cwd: string;
	readonly state: NornWorkflowState;
};

export type NornWorkflowPluginImplementation<TManifest extends NornAnyWorkflowPluginManifest> = {
	readonly workflows: {
		readonly [Key in keyof TManifest["workflows"]]: NornWorkflowImplementation<TManifest["workflows"][Key], NornWorkflowPluginConfig<TManifest>>;
	};
};

export type NornWorkflowPluginImplementationFactory<TManifest extends NornAnyWorkflowPluginManifest> = (
	context: NornWorkflowPluginContext,
) => NornWorkflowPluginImplementation<TManifest>;

export type NornWorkflowPluginImplementationInput<TManifest extends NornAnyWorkflowPluginManifest> =
	| NornWorkflowPluginImplementation<TManifest>
	| NornWorkflowPluginImplementationFactory<TManifest>;

export type NornWorkflowPlugin<TManifest extends NornAnyWorkflowPluginManifest = NornAnyWorkflowPluginManifest> = {
	readonly manifest: TManifest;
	readonly implementation: NornWorkflowPluginImplementationInput<TManifest>;
};

export function definePlugin<TManifest extends NornAnyWorkflowPluginManifest>(
	manifest: TManifest,
	implementation: NornWorkflowPluginImplementationInput<TManifest>,
): NornWorkflowPlugin<TManifest> {
	return { manifest, implementation };
}

export type NornCommandRunInput = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs?: number;
};

export const artifactRefSchema = z.object({
	path: z.string(),
});

export type NornArtifactRef = z.output<typeof artifactRefSchema>;

const emptyWorkflowRefParamsSchema = z.object({});

export function workflowRefSchema(): z.ZodType<
	NornWorkflowRefOutput<typeof emptyWorkflowRefParamsSchema>,
	NornWorkflowRefInput<typeof emptyWorkflowRefParamsSchema>
>;
export function workflowRefSchema(options: {
	readonly params?: undefined;
}): z.ZodType<
	NornWorkflowRefOutput<typeof emptyWorkflowRefParamsSchema>,
	NornWorkflowRefInput<typeof emptyWorkflowRefParamsSchema>
>;
export function workflowRefSchema<ParamsSchema extends z.ZodType>(options: NornWorkflowRefSchemaOptions<ParamsSchema>): z.ZodType<
	NornWorkflowRefOutput<ParamsSchema>,
	NornWorkflowRefInput<ParamsSchema>
>;
export function workflowRefSchema(options?: NornWorkflowRefSchemaOptions): z.ZodType {
	void options;
	return z.preprocess(
		(value) => {
			const workflowReference = isWorkflowRefInput(value) ? value : { workflow: value, forwardParams: {} };
			return {
				workflow: normalizeWorkflowRef(workflowReference.workflow),
				forwardParams: workflowReference.forwardParams,
			};
		},
		z.object({
			workflow: z.string().min(1),
			forwardParams: z.record(z.string(), z.unknown()),
		}),
	);
}

export type NornLogRef = {
	readonly id: string;
};

export type NornCommandRunResult = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd: string;
	readonly exitCode: number | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
	readonly killed: boolean;
	readonly stdoutLog: NornLogRef;
	readonly stderrLog: NornLogRef;
};

export type NornAgentBeforeSessionStartContext = {
	readonly events: EventBus;
};

export type NornAgentCreateSessionInput = {
	readonly label: string;
	readonly cwd?: string;
	readonly tools?: string[];
	readonly beforeSessionStart?: (context: NornAgentBeforeSessionStartContext) => MaybePromise<void>;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly systemPrompt?: string;
	readonly appendSystemPrompt?: readonly string[];
};

export type NornAgentPromptInput<ResponseSchema extends z.ZodType> = {
	readonly prompt: string;
	readonly response: ResponseSchema;
	readonly maxAttempts?: number;
	readonly options?: PromptOptions;
};

export type NornAgentSinglePromptInput<ResponseSchema extends z.ZodType> = NornAgentCreateSessionInput & NornAgentPromptInput<ResponseSchema>;

export type NornAgentSessionEvents = EventBus;

export type NornAgentUsageCost = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly total: number;
};

export type NornAgentUsage = {
	readonly input: number;
	readonly output: number;
	readonly cacheRead: number;
	readonly cacheWrite: number;
	readonly reasoning?: number;
	readonly totalTokens: number;
	readonly cost: NornAgentUsageCost;
};

export type NornAgentMetrics = {
	readonly index: number;
	readonly label: string;
	readonly status: "running" | "completed" | "failed";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly attempts?: number;
	readonly usage: NornAgentUsage;
};

export type NornCommandMetrics = {
	readonly index: number;
	readonly label: string;
	readonly status: "running" | "completed" | "failed";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly exitCode?: number | null;
	readonly killed?: boolean;
};

export type NornWorkflowMetrics = {
	readonly index: number;
	readonly workflowId: string;
	readonly status: "running" | "completed" | "failed" | "transitioned";
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly ownMs: number;
	readonly agentsMs: number;
	readonly commandsMs: number;
	readonly agentUsage: NornAgentUsage;
	readonly agents: readonly NornAgentMetrics[];
	readonly commands: readonly NornCommandMetrics[];
};

export type NornRunMetrics = {
	readonly status: NornRunStatus;
	readonly startedAt: string;
	readonly endedAt?: string;
	readonly wallMs: number;
	readonly activeMs: number;
	readonly gateWaitMs: number;
	readonly workflowsMs: number;
	readonly workflowOwnMs: number;
	readonly agentsMs: number;
	readonly commandsMs: number;
	readonly agentUsage: NornAgentUsage;
	readonly workflows: readonly NornWorkflowMetrics[];
};

export type NornAgentRunRawAttempt = {
	readonly attempt: number;
	readonly text: string;
	readonly messages: unknown[];
	readonly responseToolCalled: boolean;
	readonly usage: NornAgentUsage;
	readonly toolResponse?: unknown;
	readonly sessionFile?: string;
	readonly error?: string;
};

export type NornAgentRunResult<ResponseSchema extends z.ZodType> = {
	readonly label: string;
	readonly cwd: string;
	readonly response: z.output<ResponseSchema>;
	readonly usage: NornAgentUsage;
	readonly raw: {
		readonly text: string;
		readonly messages: unknown[];
		readonly responseToolCalled: boolean;
		readonly usage: NornAgentUsage;
		readonly toolResponse?: unknown;
		readonly sessionFile?: string;
		readonly attempts: readonly NornAgentRunRawAttempt[];
	};
};

export type NornAgentSession = {
	readonly label: string;
	readonly cwd: string;
	readonly events: NornAgentSessionEvents;
	prompt<ResponseSchema extends z.ZodType>(input: NornAgentPromptInput<ResponseSchema>): Promise<z.output<ResponseSchema>>;
	dispose(): Promise<void>;
};

export type NornRun = NornRunBase;

export type NornProjectRun = NornRunBase & {
	projectRoot: string;
	projectPath(relativePath: string): string;
};

type NornRunBase = {
	id: string;
	workspace: string;
	cwd: string;
	path(relativePath: string): string;
	next<TWorkflow extends NornWorkflowTarget<any>>(workflow: TWorkflow, params: NornWorkflowTargetParamsInput<TWorkflow>): NornRunNext;
	complete(metadata?: NornRunOutcomeMetadata): NornRunComplete;
	fail(metadata: NornRunOutcomeMetadata & { readonly summary: string }): NornRunFail;
	state: NornWorkflowState;
	artifacts: {
		write(path: string, content: string): Promise<NornArtifactRef>;
		read(ref: NornArtifactRef): Promise<string>;
	};
	logs: {
		read(log: NornLogRef): Promise<string>;
	};
	commands: {
		run(input: NornCommandRunInput): Promise<NornCommandRunResult>;
	};
	agents: {
		createSession(input: NornAgentCreateSessionInput): Promise<NornAgentSession>;
		prompt<ResponseSchema extends z.ZodType>(input: NornAgentSinglePromptInput<ResponseSchema>): Promise<z.output<ResponseSchema>>;
	};
};

export type NornWorkflowPluginInfo = {
	readonly id: string;
	readonly path?: string;
	readonly configPath?: string;
};

export type NornJsonSchema = Record<string, unknown>;

export type NornWorkflowGateInfo = {
	readonly enabled: true;
	readonly fields?: readonly string[];
};

export type NornRegisteredWorkflowInfo = {
	readonly id: string;
	readonly title: string | null;
	readonly description?: string;
	readonly isEntrypoint: boolean;
	readonly isolation: NornWorkflowIsolation;
	readonly plugin?: NornWorkflowPluginInfo;
};

export type NornInspectedWorkflowInfo = NornRegisteredWorkflowInfo & {
	readonly paramsSchema: NornJsonSchema;
	readonly gate: NornWorkflowGateInfo | null;
};

export type NornProjectPluginInfo = NornWorkflowPluginInfo & {
	readonly configSchema: NornJsonSchema | null;
	readonly config: unknown;
};

export type NornProjectInfo = {
	readonly cwd: string;
	readonly projectPath: string;
	readonly projectRoot: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly configFiles: readonly string[];
	readonly plugins: readonly NornProjectPluginInfo[];
	readonly seerMode: NornResolvedSeerModeConfig | null;
};

function assertLocalDeclarationId(id: string, kind: "plugin" | "workflow" | "state"): void {
	if (id.length === 0) throw new Error(`Workflow ${kind} id must not be empty`);
	if (id.includes(".")) throw new Error(`Workflow ${kind} id must not contain dots: ${id}`);
}

function resolveDeclarationId(pluginId: string, path: readonly string[], explicitId: string | undefined, kind: "workflow" | "state", declaredIds: Set<string>): string {
	for (const segment of path) assertLocalDeclarationId(segment, kind);
	const id = explicitId ?? [pluginId, ...path].join(".");
	if (explicitId !== undefined) assertPluginQualifiedId(pluginId, explicitId, kind);
	if (declaredIds.has(id)) throw new Error(`Duplicate Norn ${kind} id: ${id}`);
	declaredIds.add(id);
	return id;
}

function assertPluginQualifiedId(pluginId: string, id: string, kind: "workflow" | "state"): void {
	if (!id.startsWith(`${pluginId}.`)) throw new Error(`Explicit Norn ${kind} id must start with ${pluginId}.: ${id}`);
	if (id.length === pluginId.length + 1) throw new Error(`Explicit Norn ${kind} id must not be empty after ${pluginId}.`);
}

function qualifyWorkflow<PluginId extends string, TWorkflow extends NornAnyWorkflowDefinition>(
	pluginId: PluginId,
	key: string,
	workflow: TWorkflow,
	declaredIds: Set<string>,
): NornQualifiedPluginWorkflow<PluginId, string, TWorkflow> {
	const id = resolveDeclarationId(pluginId, [key], workflow.id, "workflow", declaredIds);
	return { kind: WORKFLOW_DECLARATION_KIND, ...workflow, id, isolation: workflow.isolation ?? { mode: "runWorkspace" } } as unknown as NornQualifiedPluginWorkflow<PluginId, string, TWorkflow>;
}

function qualifyStateTree(pluginId: string, node: NornWorkflowPluginStateTreeNode | undefined, path: readonly string[], declaredIds: Set<string>): unknown {
	if (!node) return undefined;
	if (isZodSchema(node)) return { id: resolveDeclarationId(pluginId, path, undefined, "state", declaredIds), schema: node };
	if (isWorkflowStateDefinitionInput(node)) {
		return { ...node, id: resolveDeclarationId(pluginId, path, node.id, "state", declaredIds) };
	}
	return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, qualifyStateTree(pluginId, child, [...path, key], declaredIds)]));
}

function isWorkflowRefInput(value: unknown): value is { readonly workflow: unknown; readonly forwardParams: unknown } {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { workflow?: unknown; forwardParams?: unknown };
	return "workflow" in candidate && "forwardParams" in candidate;
}

function normalizeWorkflowRef(value: unknown): unknown {
	return isWorkflowDeclaration(value) ? value.id : value;
}

export function isWorkflowDeclaration(value: unknown): value is NornAnyWorkflowDeclaration {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { kind?: unknown; id?: unknown; title?: unknown; isEntrypoint?: unknown; params?: unknown; isolation?: { mode?: unknown } };
	return (
		candidate.kind === WORKFLOW_DECLARATION_KIND &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		(candidate.title === undefined || typeof candidate.title === "string") &&
		typeof candidate.isEntrypoint === "boolean" &&
		Boolean(candidate.params) &&
		(candidate.isolation?.mode === "runWorkspace" || candidate.isolation?.mode === "project")
	);
}

function isWorkflowStateDefinitionInput(value: unknown): value is NornWorkflowStateDefinitionInput<unknown> {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { id?: unknown; schema?: unknown };
	return (candidate.id === undefined || typeof candidate.id === "string") && isZodSchema(candidate.schema);
}

function isZodSchema(value: unknown): value is z.ZodType {
	return Boolean(value && typeof value === "object" && typeof (value as { safeParse?: unknown }).safeParse === "function");
}

export function isWorkflowPlugin(value: unknown): value is NornWorkflowPlugin {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { manifest?: unknown; implementation?: unknown };
	return isWorkflowPluginManifest(candidate.manifest) && Boolean(candidate.implementation);
}

export function isWorkflowPluginManifest(value: unknown): value is NornAnyWorkflowPluginManifest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { id?: unknown; workflows?: unknown };
	if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
	if (!candidate.workflows || typeof candidate.workflows !== "object") return false;
	return Object.values(candidate.workflows).every(isWorkflowDeclaration);
}

export function isWorkflowNext(value: unknown): value is NornRunNext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; workflowId?: unknown; params?: unknown };
	return candidate.type === "next" && typeof candidate.workflowId === "string" && candidate.workflowId.length > 0;
}

export function isWorkflowComplete(value: unknown): value is NornRunComplete {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown };
	return candidate.type === "complete";
}

export function isWorkflowFail(value: unknown): value is NornRunFail {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; metadata?: { summary?: unknown } };
	return candidate.type === "fail" && typeof candidate.metadata?.summary === "string" && candidate.metadata.summary.length > 0;
}
