import { isWorkflowComplete, isWorkflowFail, isWorkflowNext, type PalantirAnyWorkflowDeclaration, type PalantirRegisteredWorkflowInfo, type PalantirRunComplete, type PalantirWorkflowConfig, type PalantirDispose, type PalantirRunFail, type PalantirWorkflowImplementation, type PalantirRunNext, type PalantirWorkflowParams, type PalantirRun } from "../api.ts";
import { assertLaunchableWorkflow, isPlainObject, schemaShape, schemaType, unwrapSchema } from "../schema.ts";

export type PalantirRegisteredWorkflow = {
	workflow: PalantirAnyWorkflowDeclaration;
	implementation: PalantirWorkflowImplementation<PalantirAnyWorkflowDeclaration>;
	config: unknown;
};

export type PalantirWorkflowStepResult =
	| PalantirRunNext
	| { readonly type: "complete"; readonly workflow: PalantirAnyWorkflowDeclaration; readonly metadata?: PalantirRunComplete["metadata"] }
	| { readonly type: "fail"; readonly workflow: PalantirAnyWorkflowDeclaration; readonly metadata: PalantirRunFail["metadata"] };

export class PalantirWorkflowRegistry {
	private readonly entries = new Map<string, PalantirRegisteredWorkflow>();

	register<TWorkflow extends PalantirAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		implementation: PalantirWorkflowImplementation<TWorkflow>,
	): PalantirDispose {
		if (this.entries.has(workflow.id)) throw new Error(`Workflow already registered: ${workflow.id}`);
		if (!workflow.config && implementation.config !== undefined) {
			throw new Error(`Workflow config provided without config schema: ${workflow.id}`);
		}

		const entry: PalantirRegisteredWorkflow = {
			workflow,
			implementation: implementation as PalantirWorkflowImplementation<PalantirAnyWorkflowDeclaration>,
			config: workflow.config ? workflow.config.parse(defaultConfigInput(workflow, implementation.config)) : undefined,
		};
		assertLaunchableWorkflow(workflow);
		assertGateWorkflow(workflow);
		this.entries.set(workflow.id, entry);

		return () => {
			if (this.entries.get(workflow.id) === entry) this.entries.delete(workflow.id);
		};
	}

	list(): PalantirRegisteredWorkflowInfo[] {
		return this.sortedEntries().map(({ workflow }) => workflowInfo(workflow));
	}

	launchableEntries(): PalantirRegisteredWorkflow[] {
		return this.sortedEntries().filter(({ workflow }) => workflow.displayTitle !== null);
	}

	workflowById(workflowId: string): PalantirAnyWorkflowDeclaration | undefined {
		return this.entries.get(workflowId)?.workflow;
	}

	async describeGate<TWorkflow extends PalantirAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		run: PalantirRun,
		params: unknown,
		configOverride?: unknown,
	): Promise<string> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);
		if (!workflow.gate) throw new Error(`Workflow is not gated: ${workflow.id}`);
		const parsedParams = workflow.params.parse(params) as PalantirWorkflowParams<TWorkflow>;
		const parsedConfig = parseExecutionConfig(workflow, entry.config, configOverride);
		const description = await (entry.implementation as PalantirWorkflowImplementation<TWorkflow>).gate?.describe(run, parsedParams, parsedConfig);
		return validateGateDescription(description ?? defaultGateDescription(workflow), workflow.id);
	}

	async execute<TWorkflow extends PalantirAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		run: PalantirRun,
		params: unknown,
		configOverride?: unknown,
	): Promise<PalantirWorkflowStepResult> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);

		const parsedParams = workflow.params.parse(params) as Parameters<PalantirWorkflowImplementation<TWorkflow>["execute"]>[1];
		const parsedConfig = parseExecutionConfig(workflow, entry.config, configOverride);
		const result = await (entry.implementation as PalantirWorkflowImplementation<TWorkflow>).execute(run, parsedParams, parsedConfig);
		if (isWorkflowNext(result)) return result;
		if (isWorkflowComplete(result)) return { type: "complete", workflow, metadata: result.metadata };
		if (isWorkflowFail(result)) return { type: "fail", workflow, metadata: result.metadata };
		throw new Error(`Workflow returned invalid control result: ${workflow.id}`);
	}

	private sortedEntries(): PalantirRegisteredWorkflow[] {
		return Array.from(this.entries.values()).sort((left, right) =>
			(left.workflow.displayTitle ?? left.workflow.id).localeCompare(right.workflow.displayTitle ?? right.workflow.id),
		);
	}
}

function defaultConfigInput(workflow: PalantirAnyWorkflowDeclaration, config: unknown): unknown {
	if (config !== undefined) return config;
	return schemaType(unwrapSchema(workflow.config)) === "object" ? {} : undefined;
}

function parseExecutionConfig<TWorkflow extends PalantirAnyWorkflowDeclaration>(
	workflow: TWorkflow,
	registeredConfig: unknown,
	configOverride: unknown,
): PalantirWorkflowConfig<TWorkflow> {
	if (!workflow.config) return undefined as PalantirWorkflowConfig<TWorkflow>;
	if (configOverride === undefined) return registeredConfig as PalantirWorkflowConfig<TWorkflow>;
	const rawConfig = isPlainObject(registeredConfig) && isPlainObject(configOverride)
		? deepMerge(registeredConfig, configOverride)
		: configOverride;
	return workflow.config.parse(rawConfig) as PalantirWorkflowConfig<TWorkflow>;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const baseValue = result[key];
		result[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
	}
	return result;
}

function assertGateWorkflow(workflow: PalantirAnyWorkflowDeclaration): void {
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

function defaultGateDescription(workflow: PalantirAnyWorkflowDeclaration): string {
	return workflow.description ?? workflow.displayTitle ?? workflow.id;
}

function validateGateDescription(description: string, workflowId: string): string {
	const trimmed = description.trim();
	if (trimmed.length === 0) throw new Error(`Workflow gate description must not be empty: ${workflowId}`);
	return trimmed;
}

function workflowInfo(workflow: PalantirAnyWorkflowDeclaration): PalantirRegisteredWorkflowInfo {
	return {
		id: workflow.id,
		displayTitle: workflow.displayTitle,
		description: workflow.description,
	};
}
