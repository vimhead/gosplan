import { isWorkflowComplete, isWorkflowFail, isWorkflowNext, type PalantirAnyWorkflowDeclaration, type PalantirInspectedWorkflowInfo, type PalantirRegisteredWorkflowInfo, type PalantirRunComplete, type PalantirWorkflowConfig, type PalantirDispose, type PalantirRunFail, type PalantirWorkflowGateInfo, type PalantirWorkflowImplementation, type PalantirRunNext, type PalantirWorkflowParams, type PalantirRun, type PalantirWorkflowPluginInfo, type PalantirWorkflowSchemaInfo, type PalantirWorkflowUiField, type PalantirWorkflowUiInfo } from "../api.ts";
import { assertLaunchableWorkflow, defaultSchemaValue, enumValues, inferInputKind, isPlainObject, schemaElement, schemaShape, schemaType, unwrapSchema } from "../schema.ts";

export type PalantirRegisteredWorkflow = {
	workflow: PalantirAnyWorkflowDeclaration;
	implementation: PalantirWorkflowImplementation<PalantirAnyWorkflowDeclaration>;
	config: unknown;
	plugin?: PalantirWorkflowPluginInfo;
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
		metadata: { readonly plugin?: PalantirWorkflowPluginInfo } = {},
	): PalantirDispose {
		if (this.entries.has(workflow.id)) throw new Error(`Workflow already registered: ${workflow.id}`);
		if (!workflow.config && implementation.config !== undefined) {
			throw new Error(`Workflow config provided without config schema: ${workflow.id}`);
		}

		const entry: PalantirRegisteredWorkflow = {
			workflow,
			implementation: implementation as PalantirWorkflowImplementation<PalantirAnyWorkflowDeclaration>,
			config: workflow.config ? workflow.config.parse(defaultConfigInput(workflow, implementation.config)) : undefined,
			plugin: metadata.plugin,
		};
		assertLaunchableWorkflow(workflow);
		assertGateWorkflow(workflow);
		this.entries.set(workflow.id, entry);

		return () => {
			if (this.entries.get(workflow.id) === entry) this.entries.delete(workflow.id);
		};
	}

	list(options: { readonly entrypointsOnly?: boolean } = {}): PalantirRegisteredWorkflowInfo[] {
		const entries = options.entrypointsOnly ? this.launchableEntries() : this.sortedEntries();
		return entries.map((entry) => workflowInfo(entry));
	}

	inspect(workflowId: string): PalantirInspectedWorkflowInfo | undefined {
		const entry = this.entries.get(workflowId);
		return entry ? inspectedWorkflowInfo(entry) : undefined;
	}

	launchableEntries(): PalantirRegisteredWorkflow[] {
		return this.sortedEntries().filter(({ workflow }) => workflow.isEntrypoint);
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
			(left.workflow.title ?? left.workflow.id).localeCompare(right.workflow.title ?? right.workflow.id),
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
	return workflow.description ?? workflow.title ?? workflow.id;
}

function validateGateDescription(description: string, workflowId: string): string {
	const trimmed = description.trim();
	if (trimmed.length === 0) throw new Error(`Workflow gate description must not be empty: ${workflowId}`);
	return trimmed;
}

function inspectedWorkflowInfo(entry: PalantirRegisteredWorkflow): PalantirInspectedWorkflowInfo {
	return {
		...workflowInfo(entry),
		params: schemaInfo(entry.workflow.params, entry.workflow.ui?.params),
		config: entry.workflow.config ? schemaInfo(entry.workflow.config, entry.workflow.ui?.config) : null,
		gate: gateInfo(entry.workflow),
	};
}

function workflowInfo(entry: PalantirRegisteredWorkflow): PalantirRegisteredWorkflowInfo {
	return {
		id: entry.workflow.id,
		title: entry.workflow.title ?? null,
		description: entry.workflow.description,
		isEntrypoint: entry.workflow.isEntrypoint,
		plugin: entry.plugin,
	};
}

function gateInfo(workflow: PalantirAnyWorkflowDeclaration): PalantirWorkflowGateInfo | null {
	return workflow.gate ? { enabled: true, fields: workflow.gate.fields } : null;
}

function schemaInfo(schema: unknown, uiFields: Record<string, PalantirWorkflowUiField> | undefined): PalantirWorkflowSchemaInfo {
	return schemaNodeInfo(schema, undefined, uiFields);
}

function schemaNodeInfo(schema: unknown, uiField: PalantirWorkflowUiField | undefined, childUiFields?: Record<string, PalantirWorkflowUiField>): PalantirWorkflowSchemaInfo {
	const unwrappedSchema = unwrapSchema(schema);
	const type = schemaType(unwrappedSchema);
	const info: PalantirWorkflowSchemaInfo = {
		type,
		required: !schemaAcceptsUndefined(schema),
		nullable: schemaAcceptsNull(schema),
		...defaultValueInfo(schema),
		...schemaInputInfo(schema, uiField),
		...schemaValuesInfo(unwrappedSchema),
		...schemaElementInfo(unwrappedSchema),
		...schemaFieldsInfo(unwrappedSchema, childUiFields),
		...schemaUiInfo(uiField),
	};
	return info;
}

function schemaInputInfo(schema: unknown, uiField: PalantirWorkflowUiField | undefined): Pick<PalantirWorkflowSchemaInfo, "input"> {
	const input = inferInputKind(schema, uiField);
	return input ? { input } : {};
}

function schemaValuesInfo(schema: unknown): Pick<PalantirWorkflowSchemaInfo, "values"> {
	return schemaType(schema) === "enum" ? { values: enumValues(schema) } : {};
}

function schemaElementInfo(schema: unknown): Pick<PalantirWorkflowSchemaInfo, "element"> {
	return schemaType(schema) === "array" ? { element: schemaNodeInfo(schemaElement(schema), undefined) } : {};
}

function schemaFieldsInfo(schema: unknown, uiFields: Record<string, PalantirWorkflowUiField> | undefined): Pick<PalantirWorkflowSchemaInfo, "fields"> {
	if (schemaType(schema) !== "object") return {};
	const fields = Object.fromEntries(Object.entries(schemaShape(schema)).map(([key, value]) => [key, schemaNodeInfo(value, uiFields?.[key])]));
	return { fields };
}

function schemaUiInfo(uiField: PalantirWorkflowUiField | undefined): Pick<PalantirWorkflowSchemaInfo, "ui"> {
	const ui = workflowUiInfo(uiField);
	return ui ? { ui } : {};
}

function workflowUiInfo(uiField: PalantirWorkflowUiField | undefined): PalantirWorkflowUiInfo | undefined {
	if (!uiField) return undefined;
	return {
		label: uiField.label,
		description: uiField.description,
		input: uiField.input,
	};
}

function defaultValueInfo(schema: unknown): Pick<PalantirWorkflowSchemaInfo, "default"> {
	const value = defaultSchemaValue(schema);
	return value === undefined ? {} : { default: value };
}

function schemaAcceptsNull(schema: unknown): boolean {
	const parser = schema as { safeParse?: (value: unknown) => { success: boolean } };
	return typeof parser.safeParse === "function" ? parser.safeParse(null).success : false;
}

function schemaAcceptsUndefined(schema: unknown): boolean {
	const parser = schema as { safeParse?: (value: unknown) => { success: boolean } };
	return typeof parser.safeParse === "function" ? parser.safeParse(undefined).success : false;
}
