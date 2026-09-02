import { z } from "zod";
import { isWorkflowComplete, isWorkflowFail, isWorkflowNext, type NornAnyWorkflowDeclaration, type NornInspectedWorkflowInfo, type NornJsonSchema, type NornRegisteredWorkflowInfo, type NornRunComplete, type NornDispose, type NornRunFail, type NornWorkflowGateInfo, type NornWorkflowImplementation, type NornRunNext, type NornRunFor, type NornWorkflowParams, type NornWorkflowPluginInfo } from "../api.ts";
import { assertLaunchableWorkflow, isPlainObject, schemaShape, schemaType, unwrapSchema } from "../schema.ts";

export type NornRegisteredWorkflow = {
	workflow: NornAnyWorkflowDeclaration;
	implementation: NornWorkflowImplementation<NornAnyWorkflowDeclaration, unknown>;
	configSchema?: z.ZodType;
	config: unknown;
	plugin?: NornWorkflowPluginInfo;
};

export type NornWorkflowStepResult =
	| NornRunNext
	| { readonly type: "complete"; readonly workflow: NornAnyWorkflowDeclaration; readonly metadata?: NornRunComplete["metadata"] }
	| { readonly type: "fail"; readonly workflow: NornAnyWorkflowDeclaration; readonly metadata: NornRunFail["metadata"] };

export class NornWorkflowRegistry {
	private readonly entries = new Map<string, NornRegisteredWorkflow>();

	register<TWorkflow extends NornAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		implementation: NornWorkflowImplementation<TWorkflow, unknown>,
		metadata: { readonly plugin?: NornWorkflowPluginInfo; readonly configSchema?: z.ZodType; readonly config?: unknown } = {},
	): NornDispose {
		if (this.entries.has(workflow.id)) throw new Error(`Workflow already registered: ${workflow.id}`);

		const entry: NornRegisteredWorkflow = {
			workflow,
			implementation: implementation as NornWorkflowImplementation<NornAnyWorkflowDeclaration, unknown>,
			configSchema: metadata.configSchema,
			config: metadata.configSchema ? metadata.configSchema.parse(defaultConfigInput(metadata.configSchema, metadata.config)) : undefined,
			plugin: metadata.plugin,
		};
		assertLaunchableWorkflow(workflow);
		assertGateWorkflow(workflow);
		this.entries.set(workflow.id, entry);

		return () => {
			if (this.entries.get(workflow.id) === entry) this.entries.delete(workflow.id);
		};
	}

	list(options: { readonly entrypointsOnly?: boolean } = {}): NornRegisteredWorkflowInfo[] {
		const entries = options.entrypointsOnly ? this.launchableEntries() : this.sortedEntries();
		return entries.map((entry) => workflowInfo(entry));
	}

	inspect(workflowId: string): NornInspectedWorkflowInfo | undefined {
		const entry = this.entries.get(workflowId);
		return entry ? inspectedWorkflowInfo(entry) : undefined;
	}

	launchableEntries(): NornRegisteredWorkflow[] {
		return this.sortedEntries().filter(({ workflow }) => workflow.isEntrypoint);
	}

	workflowById(workflowId: string): NornAnyWorkflowDeclaration | undefined {
		return this.entries.get(workflowId)?.workflow;
	}

	async describeGate<TWorkflow extends NornAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		run: NornRunFor<TWorkflow>,
		params: unknown,
		configOverride?: unknown,
	): Promise<string> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);
		if (!workflow.gate) throw new Error(`Workflow is not gated: ${workflow.id}`);
		const parsedParams = workflow.params.parse(params) as NornWorkflowParams<TWorkflow>;
		const parsedConfig = parseExecutionConfig(entry, configOverride);
		const description = await (entry.implementation as NornWorkflowImplementation<TWorkflow, unknown>).gate?.describe(run, parsedParams, parsedConfig);
		return validateGateDescription(description ?? defaultGateDescription(workflow), workflow.id);
	}

	async execute<TWorkflow extends NornAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		run: NornRunFor<TWorkflow>,
		params: unknown,
		configOverride?: unknown,
	): Promise<NornWorkflowStepResult> {
		const entry = this.entries.get(workflow.id);
		if (!entry) throw new Error(`Unknown workflow: ${workflow.id}`);

		const parsedParams = workflow.params.parse(params) as Parameters<NornWorkflowImplementation<TWorkflow, unknown>["execute"]>[1];
		const parsedConfig = parseExecutionConfig(entry, configOverride);
		const result = await (entry.implementation as NornWorkflowImplementation<TWorkflow, unknown>).execute(run, parsedParams, parsedConfig);
		if (isWorkflowNext(result)) return result;
		if (isWorkflowComplete(result)) return { type: "complete", workflow, metadata: result.metadata };
		if (isWorkflowFail(result)) return { type: "fail", workflow, metadata: result.metadata };
		throw new Error(`Workflow returned invalid control result: ${workflow.id}`);
	}

	private sortedEntries(): NornRegisteredWorkflow[] {
		return Array.from(this.entries.values()).sort((left, right) =>
			(left.workflow.title ?? left.workflow.id).localeCompare(right.workflow.title ?? right.workflow.id),
		);
	}
}

function defaultConfigInput(configSchema: z.ZodType, config: unknown): unknown {
	if (config !== undefined) return config;
	return schemaType(unwrapSchema(configSchema)) === "object" ? {} : undefined;
}

function parseExecutionConfig(entry: NornRegisteredWorkflow, configOverride: unknown): unknown {
	const pluginConfigOverride = pluginConfigOverrideInput(entry, configOverride);
	if (!entry.configSchema) {
		if (pluginConfigOverride !== undefined) throw new Error(`Run config override provided for plugin without config schema: ${entry.plugin?.id ?? entry.workflow.id}`);
		return undefined;
	}
	if (pluginConfigOverride === undefined) return entry.config;
	const rawConfig = isPlainObject(entry.config) && isPlainObject(pluginConfigOverride)
		? deepMerge(entry.config, pluginConfigOverride)
		: pluginConfigOverride;
	return entry.configSchema.parse(rawConfig);
}

function pluginConfigOverrideInput(entry: NornRegisteredWorkflow, configOverride: unknown): unknown {
	if (configOverride === undefined) return undefined;
	if (!isPlainObject(configOverride)) throw new Error("Run config override must be an object keyed by plugin id");
	const pluginId = entry.plugin?.id;
	return pluginId ? configOverride[pluginId] : undefined;
}

function deepMerge(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const baseValue = result[key];
		result[key] = isPlainObject(baseValue) && isPlainObject(value) ? deepMerge(baseValue, value) : value;
	}
	return result;
}

function assertGateWorkflow(workflow: NornAnyWorkflowDeclaration): void {
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

function defaultGateDescription(workflow: NornAnyWorkflowDeclaration): string {
	return workflow.description ?? workflow.title ?? workflow.id;
}

function validateGateDescription(description: string, workflowId: string): string {
	const trimmed = description.trim();
	if (trimmed.length === 0) throw new Error(`Workflow gate description must not be empty: ${workflowId}`);
	return trimmed;
}

function inspectedWorkflowInfo(entry: NornRegisteredWorkflow): NornInspectedWorkflowInfo {
	return {
		...workflowInfo(entry),
		paramsSchema: jsonSchema(entry.workflow.params),
		gate: gateInfo(entry.workflow),
	};
}

function workflowInfo(entry: NornRegisteredWorkflow): NornRegisteredWorkflowInfo {
	return {
		id: entry.workflow.id,
		title: entry.workflow.title ?? null,
		description: entry.workflow.description,
		isEntrypoint: entry.workflow.isEntrypoint,
		isolation: entry.workflow.isolation,
		plugin: entry.plugin,
	};
}

function gateInfo(workflow: NornAnyWorkflowDeclaration): NornWorkflowGateInfo | null {
	return workflow.gate ? { enabled: true, fields: workflow.gate.fields } : null;
}

function jsonSchema(schema: z.ZodType): NornJsonSchema {
	return z.toJSONSchema(schema, { io: "input" }) as NornJsonSchema;
}
