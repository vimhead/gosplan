import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import { z } from "zod";

const WORKFLOW_DECLARATION_KIND = "palantir.workflow";

export type MaybePromise<T> = T | Promise<T>;
export type WorkflowDispose = () => void;

export type WorkflowAnyGate = {
	readonly enabled: true;
	readonly fields?: readonly string[];
};

export type WorkflowResolvedGate = {
	readonly description: string;
	readonly fields?: readonly string[];
};

export type WorkflowDeclaration<
	Id extends string = string,
	ConfigSchema extends z.ZodType | undefined = z.ZodType | undefined,
	ParamsSchema extends z.ZodType = z.ZodType,
> = {
	readonly kind: typeof WORKFLOW_DECLARATION_KIND;
	readonly id: Id;
	readonly displayTitle: string | null;
	readonly description?: string;
	readonly config?: ConfigSchema;
	readonly params: ParamsSchema;
	readonly gate?: WorkflowAnyGate;
	readonly ui?: WorkflowUi;
};

export type AnyWorkflowDeclaration = WorkflowDeclaration<string, z.ZodType | undefined, z.ZodType>;

export type WorkflowConfigInput<TWorkflow extends AnyWorkflowDeclaration> = NonNullable<TWorkflow["config"]> extends z.ZodType
	? z.input<NonNullable<TWorkflow["config"]>>
	: undefined;

export type WorkflowConfig<TWorkflow extends AnyWorkflowDeclaration> = NonNullable<TWorkflow["config"]> extends z.ZodType
	? z.output<NonNullable<TWorkflow["config"]>>
	: undefined;

export type WorkflowParamsInput<TWorkflow extends AnyWorkflowDeclaration> = z.input<TWorkflow["params"]>;
export type WorkflowParams<TWorkflow extends AnyWorkflowDeclaration> = z.output<TWorkflow["params"]>;
export type WorkflowConfigOverride<TWorkflow extends AnyWorkflowDeclaration> = NonNullable<TWorkflow["config"]> extends z.ZodType
	? Partial<z.input<NonNullable<TWorkflow["config"]>>>
	: never;

export type WorkflowUiScalarInputKind = "input" | "textarea" | "number" | "boolean";
export type WorkflowUiInputKind = WorkflowUiScalarInputKind | "select" | "multiSelect";

export type WorkflowStringListStateDefinition = WorkflowStateDefinition<string[]> | WorkflowStateDefinition<readonly string[]>;

type WorkflowUiFieldBase = {
	readonly label?: string;
	readonly description?: string;
};

export type WorkflowUiField =
	| (WorkflowUiFieldBase & { readonly input?: WorkflowUiScalarInputKind; readonly options?: never })
	| (WorkflowUiFieldBase & { readonly input: "select"; readonly options?: WorkflowStringListStateDefinition })
	| (WorkflowUiFieldBase & { readonly input: "multiSelect"; readonly options: WorkflowStringListStateDefinition });

export type WorkflowUi = {
	readonly params?: Record<string, WorkflowUiField>;
	readonly config?: Record<string, WorkflowUiField>;
};

export type WorkflowGate<ParamsSchema extends z.ZodType> = unknown extends z.input<ParamsSchema>
	? WorkflowAnyGate
	: z.input<ParamsSchema> extends Record<string, unknown>
		? {
			readonly enabled: true;
			readonly fields?: readonly Extract<keyof z.input<ParamsSchema>, string>[];
		}
		: {
			readonly enabled: true;
			readonly fields?: never;
		};

export type WorkflowDefinition<
	Id extends string | undefined = string | undefined,
	ConfigSchema extends z.ZodType | undefined = z.ZodType | undefined,
	ParamsSchema extends z.ZodType = z.ZodType,
> = {
	readonly id?: Id;
	readonly displayTitle: string | null;
	readonly description?: string;
	readonly config?: ConfigSchema;
	readonly params: ParamsSchema;
	readonly gate?: WorkflowGate<ParamsSchema>;
	readonly ui?: WorkflowUi;
};

export type AnyWorkflowDefinition = {
	readonly id?: string;
	readonly displayTitle: string | null;
	readonly description?: string;
	readonly config?: z.ZodType;
	readonly params: z.ZodType;
	readonly gate?: WorkflowAnyGate;
	readonly ui?: WorkflowUi;
};

export type WorkflowStateDefinition<T = unknown, Id extends string = string> = {
	readonly id: Id;
	readonly description?: string;
	readonly schema: z.ZodType<T>;
};

export type WorkflowStateDefinitionInput<T = unknown, Id extends string | undefined = string | undefined> = {
	readonly id?: Id;
	readonly description?: string;
	readonly schema: z.ZodType<T>;
};

export type WorkflowPluginWorkflows = Record<string, AnyWorkflowDefinition>;
export type WorkflowPluginStateTree = { readonly [key: string]: WorkflowPluginStateTreeNode };
export type WorkflowPluginStateTreeNode = z.ZodType | WorkflowStateDefinitionInput | WorkflowPluginStateTree;

type JoinPath<Head extends string, Parts extends readonly string[]> = Parts extends readonly []
	? Head
	: Parts extends readonly [infer First extends string, ...infer Rest extends string[]]
		? JoinPath<`${Head}.${First}`, Rest>
		: string;

type InvalidGateFields<TWorkflow> = TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType; readonly gate: { readonly fields: infer Fields extends readonly string[] } }
	? Exclude<Fields[number], Extract<keyof z.input<ParamsSchema>, string>>
	: never;

type ValidatedWorkflowGate<TWorkflow> = [InvalidGateFields<TWorkflow>] extends [never]
	? unknown
	: { readonly gate: { readonly fields: readonly Extract<keyof z.input<TWorkflow extends { readonly params: infer ParamsSchema extends z.ZodType } ? ParamsSchema : z.ZodType>, string>[] } };

export type ValidatedWorkflowGates<Workflows> = {
	readonly [Key in keyof Workflows]: ValidatedWorkflowGate<Workflows[Key]>;
};

export type QualifiedPluginWorkflow<
	PluginId extends string,
	WorkflowKey extends string,
	TWorkflow extends AnyWorkflowDefinition,
> = TWorkflow extends {
	readonly config?: infer ConfigSchema extends z.ZodType | undefined;
	readonly params: infer ParamsSchema extends z.ZodType;
}
	? WorkflowDeclaration<
		TWorkflow extends { readonly id: infer ExplicitId extends string } ? ExplicitId : `${PluginId}.${WorkflowKey}`,
		ConfigSchema,
		ParamsSchema
	>
	: never;

export type QualifiedPluginWorkflows<PluginId extends string, Workflows extends WorkflowPluginWorkflows> = {
	readonly [Key in keyof Workflows]: QualifiedPluginWorkflow<PluginId, Key & string, Workflows[Key]>;
};

export type QualifiedPluginStates<PluginId extends string, States, Path extends readonly string[] = []> = {
	readonly [Key in keyof States]: States[Key] extends z.ZodType
		? WorkflowStateDefinition<z.output<States[Key]>, JoinPath<PluginId, [...Path, Key & string]>>
		: States[Key] extends WorkflowStateDefinitionInput<infer Value>
			? WorkflowStateDefinition<
				Value,
				States[Key] extends { readonly id: infer ExplicitId extends string } ? ExplicitId : JoinPath<PluginId, [...Path, Key & string]>
			>
			: States[Key] extends WorkflowPluginStateTree
				? QualifiedPluginStates<PluginId, States[Key], [...Path, Key & string]>
				: never;
};

export type WorkflowPluginManifest<
	PluginId extends string = string,
	Workflows extends Record<string, AnyWorkflowDeclaration> = Record<string, AnyWorkflowDeclaration>,
	States = undefined,
> = {
	readonly id: PluginId;
	readonly workflows: Workflows;
	readonly states: States;
};

export type AnyWorkflowPluginManifest = WorkflowPluginManifest<string, Record<string, AnyWorkflowDeclaration>, unknown>;

export type DefinePluginManifestInput<
	PluginId extends string,
	Workflows extends WorkflowPluginWorkflows,
	States extends WorkflowPluginStateTree | undefined,
> = {
	readonly id: PluginId;
	readonly workflows: Workflows & ValidatedWorkflowGates<Workflows>;
	readonly states?: States;
};

export function definePluginManifest<
	const PluginId extends string,
	const Workflows extends WorkflowPluginWorkflows,
	const States extends WorkflowPluginStateTree | undefined = undefined,
>(
	input: DefinePluginManifestInput<PluginId, Workflows, States>,
): WorkflowPluginManifest<
	PluginId,
	QualifiedPluginWorkflows<PluginId, Workflows>,
	States extends WorkflowPluginStateTree ? QualifiedPluginStates<PluginId, States> : undefined
> {
	assertLocalDeclarationId(input.id, "plugin");
	const declaredIds = new Set<string>();
	const workflows = Object.fromEntries(
		Object.entries(input.workflows).map(([key, workflow]) => [key, qualifyWorkflow(input.id, key, workflow, declaredIds)]),
	) as QualifiedPluginWorkflows<PluginId, Workflows>;
	return {
		id: input.id,
		workflows,
		states: qualifyStateTree(input.id, input.states, [], declaredIds) as States extends WorkflowPluginStateTree ? QualifiedPluginStates<PluginId, States> : undefined,
	};
}

export type WorkflowNext = {
	readonly type: "next";
	readonly workflowId: string;
	readonly params: unknown;
	readonly configOverride?: unknown;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
};

export type WorkflowOutcomeMetadata = {
	readonly summary?: string;
	readonly artifacts?: Record<string, WorkflowArtifactRef>;
	readonly logs?: Record<string, WorkflowLogRef>;
	readonly data?: Record<string, unknown>;
};

export type WorkflowComplete = {
	readonly type: "complete";
	readonly metadata?: WorkflowOutcomeMetadata;
};

export type WorkflowFail = {
	readonly type: "fail";
	readonly metadata: WorkflowOutcomeMetadata & { readonly summary: string };
};

export type WorkflowExecutionResult = WorkflowNext | WorkflowComplete | WorkflowFail;

export type WorkflowGateImplementation<TWorkflow extends AnyWorkflowDeclaration> = {
	describe(
		runtime: WorkflowRuntime,
		params: WorkflowParams<TWorkflow>,
		config: WorkflowConfig<TWorkflow>,
	): MaybePromise<string>;
};

export type WorkflowImplementation<TWorkflow extends AnyWorkflowDeclaration> = {
	readonly config?: WorkflowConfigInput<TWorkflow>;
	readonly gate?: WorkflowGateImplementation<TWorkflow>;
	execute(
		runtime: WorkflowRuntime,
		params: WorkflowParams<TWorkflow>,
		config: WorkflowConfig<TWorkflow>,
	): MaybePromise<WorkflowExecutionResult>;
};

export type WorkflowCallOptions<TWorkflow extends AnyWorkflowDeclaration> = {
	readonly configOverride?: WorkflowConfigOverride<TWorkflow>;
};

export type WorkflowLaunchOptions<TWorkflow extends AnyWorkflowDeclaration = AnyWorkflowDeclaration> = WorkflowCallOptions<TWorkflow> & {
	readonly id?: string;
	readonly name?: string;
	readonly cwd?: string;
	readonly env?: Record<string, string>;
};

export type AnyWorkflowLaunchOptions = Omit<WorkflowLaunchOptions<AnyWorkflowDeclaration>, "configOverride"> & {
	readonly configOverride?: unknown;
};

export type WorkflowStartedLaunchResult = {
	readonly status: "running";
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
};

export type WorkflowCompletedLaunchResult = {
	readonly status: "completed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata?: WorkflowOutcomeMetadata;
};

export type WorkflowFailedLaunchResult = {
	readonly status: "failed";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly metadata: WorkflowOutcomeMetadata & { readonly summary: string };
};

export type WorkflowInterruptedLaunchResult = {
	readonly status: "interrupted";
	readonly id: string;
	readonly name: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly workflowId: string;
	readonly params: unknown;
	readonly gate: WorkflowResolvedGate;
};

export type WorkflowLaunchResult = WorkflowStartedLaunchResult | WorkflowCompletedLaunchResult | WorkflowFailedLaunchResult | WorkflowInterruptedLaunchResult;

export type WorkflowRunStatus = "running" | "interrupted" | "completed" | "failed";
export type WorkflowRunHealth = "healthy" | "unhealthy";

export type WorkflowRunInfo = {
	readonly version: number;
	readonly id: string;
	readonly name: string;
	readonly path: string;
	readonly rootWorkflowId: string;
	readonly currentWorkflowId?: string;
	readonly status: WorkflowRunStatus;
	readonly health: WorkflowRunHealth;
	readonly startedAt: string;
	readonly updatedAt: string;
};

export type DeletedWorkflowRunInfo = {
	readonly id: string;
	readonly name: string;
	readonly path: string;
};

export type WorkflowRunCheckpoint = {
	readonly id: string;
	readonly path: string;
	readonly index: number;
	readonly message: string;
	readonly createdAt: string;
};

export type WorkflowStateReader = {
	get<T>(state: WorkflowStateDefinition<T>): Promise<T>;
	getOptional<T>(state: WorkflowStateDefinition<T>): Promise<T | undefined>;
};

export type WorkflowState = WorkflowStateReader & {
	set<T>(state: WorkflowStateDefinition<T>, value: T): Promise<void>;
};

export type WorkflowPluginContext = {
	readonly cwd: string;
	readonly state: WorkflowState;
};

export type WorkflowPluginImplementation<TManifest extends AnyWorkflowPluginManifest> = {
	readonly workflows: {
		readonly [Key in keyof TManifest["workflows"]]: WorkflowImplementation<TManifest["workflows"][Key]>;
	};
};

export type WorkflowPluginImplementationFactory<TManifest extends AnyWorkflowPluginManifest> = (
	context: WorkflowPluginContext,
) => WorkflowPluginImplementation<TManifest>;

export type WorkflowPluginImplementationInput<TManifest extends AnyWorkflowPluginManifest> =
	| WorkflowPluginImplementation<TManifest>
	| WorkflowPluginImplementationFactory<TManifest>;

export type WorkflowPlugin<TManifest extends AnyWorkflowPluginManifest = AnyWorkflowPluginManifest> = {
	readonly manifest: TManifest;
	readonly implementation: WorkflowPluginImplementationInput<TManifest>;
};

export function definePlugin<TManifest extends AnyWorkflowPluginManifest>(
	manifest: TManifest,
	implementation: WorkflowPluginImplementationInput<TManifest>,
): WorkflowPlugin<TManifest> {
	return { manifest, implementation };
}

export type CommandRunInput = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd?: string;
	readonly env?: Record<string, string>;
	readonly timeoutMs?: number;
};

export const workflowArtifactRefSchema = z.object({
	path: z.string(),
});

export type WorkflowArtifactRef = z.output<typeof workflowArtifactRefSchema>;

export type WorkflowLogRef = {
	readonly id: string;
};

export type CommandRunResult = {
	readonly label: string;
	readonly command: string | readonly [string, ...string[]];
	readonly cwd: string;
	readonly exitCode: number | null;
	readonly stdoutTail: string;
	readonly stderrTail: string;
	readonly killed: boolean;
	readonly stdoutLog: WorkflowLogRef;
	readonly stderrLog: WorkflowLogRef;
};

export type AgentSpawnInput = {
	readonly label: string;
	readonly cwd?: string;
	readonly tools?: string[];
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
};

export type AgentPromptInput<ResponseSchema extends z.ZodType> = {
	readonly prompt: string;
	readonly response: ResponseSchema;
	readonly maxAttempts?: number;
};

export type AgentRunInput<ResponseSchema extends z.ZodType> = AgentSpawnInput & AgentPromptInput<ResponseSchema>;

export type AgentSessionEvents = {
	emit(name: string, data?: unknown): void;
	on(name: string, handler: (data: unknown) => void): WorkflowDispose;
};

export type AgentRunRawAttempt = {
	readonly attempt: number;
	readonly text: string;
	readonly messages: unknown[];
	readonly responseToolCalled: boolean;
	readonly toolResponse?: unknown;
	readonly sessionFile?: string;
	readonly error?: string;
};

export type AgentRunResult<ResponseSchema extends z.ZodType> = {
	readonly label: string;
	readonly cwd: string;
	readonly response: z.output<ResponseSchema>;
	readonly raw: {
		readonly text: string;
		readonly messages: unknown[];
		readonly responseToolCalled: boolean;
		readonly toolResponse?: unknown;
		readonly sessionFile?: string;
		readonly attempts: readonly AgentRunRawAttempt[];
	};
};

export type WorkflowAgentSession = {
	readonly label: string;
	readonly cwd: string;
	readonly events: AgentSessionEvents;
	run<ResponseSchema extends z.ZodType>(input: AgentPromptInput<ResponseSchema>): Promise<AgentRunResult<ResponseSchema>>;
	dispose(): Promise<void>;
};

export type WorkflowRuntime = {
	id: string;
	workspace: string;
	cwd: string;
	with(options: { cwd?: string; env?: Record<string, string> }): WorkflowRuntime;
	path(relativePath: string): string;
	next<TWorkflow extends AnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: WorkflowParamsInput<TWorkflow>,
		options?: WorkflowCallOptions<TWorkflow>,
	): WorkflowNext;
	next(workflowId: string, params: unknown, options?: { readonly configOverride?: unknown }): WorkflowNext;
	complete(metadata?: WorkflowOutcomeMetadata): WorkflowComplete;
	fail(metadata: WorkflowOutcomeMetadata & { readonly summary: string }): WorkflowFail;
	state: WorkflowState;
	artifacts: {
		write(path: string, content: string): Promise<WorkflowArtifactRef>;
		read(ref: WorkflowArtifactRef): Promise<string>;
	};
	logs: {
		read(log: WorkflowLogRef): Promise<string>;
	};
	commands: {
		run(input: CommandRunInput): Promise<CommandRunResult>;
	};
	agents: {
		spawn(input: AgentSpawnInput): Promise<WorkflowAgentSession>;
		run<ResponseSchema extends z.ZodType>(input: AgentRunInput<ResponseSchema>): Promise<AgentRunResult<ResponseSchema>>;
	};
};

export type RegisteredWorkflowInfo = {
	id: string;
	displayTitle: string | null;
	description?: string;
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

function qualifyWorkflow<PluginId extends string, TWorkflow extends AnyWorkflowDefinition>(
	pluginId: PluginId,
	key: string,
	workflow: TWorkflow,
	declaredIds: Set<string>,
): QualifiedPluginWorkflow<PluginId, string, TWorkflow> {
	const id = resolveDeclarationId(pluginId, [key], workflow.id, "workflow", declaredIds);
	return { kind: WORKFLOW_DECLARATION_KIND, ...workflow, id } as unknown as QualifiedPluginWorkflow<PluginId, string, TWorkflow>;
}

function qualifyStateTree(pluginId: string, node: WorkflowPluginStateTreeNode | undefined, path: readonly string[], declaredIds: Set<string>): unknown {
	if (!node) return undefined;
	if (isZodSchema(node)) return { id: resolveDeclarationId(pluginId, path, undefined, "state", declaredIds), schema: node };
	if (isWorkflowStateDefinitionInput(node)) {
		return { ...node, id: resolveDeclarationId(pluginId, path, node.id, "state", declaredIds) };
	}
	return Object.fromEntries(Object.entries(node).map(([key, child]) => [key, qualifyStateTree(pluginId, child, [...path, key], declaredIds)]));
}

export function isWorkflowDeclaration(value: unknown): value is AnyWorkflowDeclaration {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { kind?: unknown; id?: unknown; displayTitle?: unknown; params?: unknown };
	return (
		candidate.kind === WORKFLOW_DECLARATION_KIND &&
		typeof candidate.id === "string" &&
		candidate.id.length > 0 &&
		(candidate.displayTitle === null || typeof candidate.displayTitle === "string") &&
		Boolean(candidate.params)
	);
}

function isWorkflowStateDefinitionInput(value: unknown): value is WorkflowStateDefinitionInput<unknown> {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { id?: unknown; schema?: unknown };
	return (candidate.id === undefined || typeof candidate.id === "string") && isZodSchema(candidate.schema);
}

function isZodSchema(value: unknown): value is z.ZodType {
	return Boolean(value && typeof value === "object" && typeof (value as { safeParse?: unknown }).safeParse === "function");
}

export function isWorkflowPlugin(value: unknown): value is WorkflowPlugin {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { manifest?: unknown; implementation?: unknown };
	return isWorkflowPluginManifest(candidate.manifest) && Boolean(candidate.implementation);
}

export function isWorkflowPluginManifest(value: unknown): value is AnyWorkflowPluginManifest {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { id?: unknown; workflows?: unknown };
	if (typeof candidate.id !== "string" || candidate.id.length === 0) return false;
	if (!candidate.workflows || typeof candidate.workflows !== "object") return false;
	return Object.values(candidate.workflows).every(isWorkflowDeclaration);
}

export function isWorkflowNext(value: unknown): value is WorkflowNext {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; workflowId?: unknown; params?: unknown };
	return candidate.type === "next" && typeof candidate.workflowId === "string" && candidate.workflowId.length > 0;
}

export function isWorkflowComplete(value: unknown): value is WorkflowComplete {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown };
	return candidate.type === "complete";
}

export function isWorkflowFail(value: unknown): value is WorkflowFail {
	if (!value || typeof value !== "object") return false;
	const candidate = value as { type?: unknown; metadata?: { summary?: unknown } };
	return candidate.type === "fail" && typeof candidate.metadata?.summary === "string" && candidate.metadata.summary.length > 0;
}
