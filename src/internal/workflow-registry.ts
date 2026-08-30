import { isWorkflowComplete, isWorkflowFail, isWorkflowNext, type AnyWorkflowDeclaration, type RegisteredWorkflowInfo, type WorkflowComplete, type WorkflowConfig, type WorkflowDispose, type WorkflowFail, type WorkflowImplementation, type WorkflowNext, type WorkflowParams, type WorkflowRuntime } from "../api.ts";
import { assertLaunchableWorkflow, isPlainObject, schemaShape, schemaType, unwrapSchema } from "../schema.ts";

export type RegisteredWorkflow = {
	workflow: AnyWorkflowDeclaration;
	implementation: WorkflowImplementation<AnyWorkflowDeclaration>;
	config: unknown;
};

export type WorkflowStepResult =
	| WorkflowNext
	| { readonly type: "complete"; readonly workflow: AnyWorkflowDeclaration; readonly metadata?: WorkflowComplete["metadata"] }
	| { readonly type: "fail"; readonly workflow: AnyWorkflowDeclaration; readonly metadata: WorkflowFail["metadata"] };

export class WorkflowRegistry {
	private readonly entries = new Map<string, RegisteredWorkflow>();

	register<TWorkflow extends AnyWorkflowDeclaration>(
		workflow: TWorkflow,
		implementation: WorkflowImplementation<TWorkflow>,
	): WorkflowDispose {
		if (this.entries.has(workflow.id)) throw new Error(`Workflow already registered: ${workflow.id}`);
		if (!workflow.config && implementation.config !== undefined) {
			throw new Error(`Workflow config provided without config schema: ${workflow.id}`);
		}

		const entry: RegisteredWorkflow = {
			workflow,
			implementation: implementation as WorkflowImplementation<AnyWorkflowDeclaration>,
			config: workflow.config ? workflow.config.parse(defaultConfigInput(workflow, implementation.config)) : undefined,
		};
		assertLaunchableWorkflow(workflow);
		assertGateWorkflow(workflow);
		this.entries.set(workflow.id, entry);

		return () => {
			if (this.entries.get(workflow.id) === entry) this.entries.delete(workflow.id);
		};
	}

	list(): RegisteredWorkflowInfo[] {
		return this.sortedEntries().map(({ workflow }) => workflowInfo(workflow));
	}

	launchableEntries(): RegisteredWorkflow[] {
		return this.sortedEntries().filter(({ workflow }) => workflow.displayTitle !== null);
	}

	workflowById(workflowId: string): AnyWorkflowDeclaration | undefined {
		return this.entries.get(workflowId)?.workflow;
	}

	async describeGate<TWorkflow extends AnyWorkflowDeclaration>(
		workflow: TWorkflow,
		runtime: WorkflowRuntime,
		params: unknown,
		configOverride?: unknown,
	): Promise<string> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);
		if (!workflow.gate) throw new Error(`Workflow is not gated: ${workflow.id}`);
		const parsedParams = workflow.params.parse(params) as WorkflowParams<TWorkflow>;
		const parsedConfig = parseExecutionConfig(workflow, entry.config, configOverride);
		const description = await (entry.implementation as WorkflowImplementation<TWorkflow>).gate?.describe(runtime, parsedParams, parsedConfig);
		return validateGateDescription(description ?? defaultGateDescription(workflow), workflow.id);
	}

	async execute<TWorkflow extends AnyWorkflowDeclaration>(
		workflow: TWorkflow,
		runtime: WorkflowRuntime,
		params: unknown,
		configOverride?: unknown,
	): Promise<WorkflowStepResult> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);

		const parsedParams = workflow.params.parse(params) as Parameters<WorkflowImplementation<TWorkflow>["execute"]>[1];
		const parsedConfig = parseExecutionConfig(workflow, entry.config, configOverride);
		const result = await (entry.implementation as WorkflowImplementation<TWorkflow>).execute(runtime, parsedParams, parsedConfig);
		if (isWorkflowNext(result)) return result;
		if (isWorkflowComplete(result)) return { type: "complete", workflow, metadata: result.metadata };
		if (isWorkflowFail(result)) return { type: "fail", workflow, metadata: result.metadata };
		throw new Error(`Workflow returned invalid control result: ${workflow.id}`);
	}

	private sortedEntries(): RegisteredWorkflow[] {
		return Array.from(this.entries.values()).sort((left, right) =>
			(left.workflow.displayTitle ?? left.workflow.id).localeCompare(right.workflow.displayTitle ?? right.workflow.id),
		);
	}
}

function defaultConfigInput(workflow: AnyWorkflowDeclaration, config: unknown): unknown {
	if (config !== undefined) return config;
	return schemaType(unwrapSchema(workflow.config)) === "object" ? {} : undefined;
}

function parseExecutionConfig<TWorkflow extends AnyWorkflowDeclaration>(
	workflow: TWorkflow,
	registeredConfig: unknown,
	configOverride: unknown,
): WorkflowConfig<TWorkflow> {
	if (!workflow.config) return undefined as WorkflowConfig<TWorkflow>;
	if (configOverride === undefined) return registeredConfig as WorkflowConfig<TWorkflow>;
	const rawConfig = isPlainObject(registeredConfig) && isPlainObject(configOverride)
		? deepMerge(registeredConfig, configOverride)
		: configOverride;
	return workflow.config.parse(rawConfig) as WorkflowConfig<TWorkflow>;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const baseValue = result[key];
		result[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
	}
	return result;
}

function assertGateWorkflow(workflow: AnyWorkflowDeclaration): void {
	if (!workflow.gate) return;
	if (workflow.gate.enabled !== true) throw new Error(`Workflow gate must be enabled with true: ${workflow.id}`);
	if (!workflow.gate.fields) return;
	const paramsSchema = unwrapSchema(workflow.params);
	if (schemaType(paramsSchema) !== "object") throw new Error(`Workflow gate fields require object params: ${workflow.id}`);
	const paramsShape = schemaShape(paramsSchema);
	for (const field of workflow.gate.fields) {
		if (!Object.prototype.hasOwnProperty.call(paramsShape, field)) throw new Error(`Unknown workflow gate field ${field}: ${workflow.id}`);
	}
}

function defaultGateDescription(workflow: AnyWorkflowDeclaration): string {
	return workflow.description ?? workflow.displayTitle ?? workflow.id;
}

function validateGateDescription(description: string, workflowId: string): string {
	const trimmed = description.trim();
	if (trimmed.length === 0) throw new Error(`Workflow gate description must not be empty: ${workflowId}`);
	return trimmed;
}

function workflowInfo(workflow: AnyWorkflowDeclaration): RegisteredWorkflowInfo {
	return {
		id: workflow.id,
		displayTitle: workflow.displayTitle,
		description: workflow.description,
	};
}
