import type { AnyWorkflowDeclaration, WorkflowUiField } from "./api.ts";

export function assertLaunchableWorkflow(_workflow: AnyWorkflowDeclaration): void {}

export function inferInputKind(schema: unknown, uiField: WorkflowUiField | undefined): WorkflowUiField["input"] | undefined {
	if (uiField?.input !== undefined) return uiField.input;
	const unwrappedSchema = unwrapSchema(schema);
	const type = schemaType(unwrappedSchema);
	if (type === "string") return "input";
	if (type === "enum") return "select";
	if (type === "number") return "number";
	if (type === "boolean") return "boolean";
	if (type !== "array") return undefined;

	const element = unwrapSchema(schemaElement(unwrappedSchema));
	const elementType = schemaType(element);
	if (elementType === "enum") return "multiSelect";
	return undefined;
}

export function isRequiredSchema(schema: unknown): boolean {
	const parser = schema as { safeParse?: (value: unknown) => { success: boolean } };
	return typeof parser.safeParse === "function" ? !parser.safeParse(undefined).success : true;
}

export function acceptsNull(schema: unknown): boolean {
	const parser = schema as { safeParse?: (value: unknown) => { success: boolean } };
	return typeof parser.safeParse === "function" ? parser.safeParse(null).success : false;
}

export function acceptsUndefined(schema: unknown): boolean {
	return !isRequiredSchema(schema);
}

export function defaultSchemaValue(schema: unknown): unknown {
	const parser = schema as { safeParse?: (value: unknown) => { success: true; data: unknown } | { success: false } };
	if (typeof parser.safeParse !== "function") return undefined;
	const result = parser.safeParse(undefined);
	return result.success ? result.data : undefined;
}

export function enumValues(schema: unknown): string[] {
	const entries = schemaDef(unwrapSchema(schema)).entries;
	if (!entries || typeof entries !== "object") return [];
	return Object.values(entries).filter((value): value is string => typeof value === "string");
}

export function unwrapSchema(schema: unknown): unknown {
	let current = schema;
	while (true) {
		const def = schemaDef(current);
		if (["optional", "nullable", "default", "catch", "readonly", "prefault"].includes(def.type ?? "") && def.innerType) {
			current = def.innerType;
			continue;
		}
		return current;
	}
}

export function schemaShape(schema: unknown): Record<string, unknown> {
	const shape = schemaDef(unwrapSchema(schema)).shape;
	if (!shape) return {};
	return typeof shape === "function" ? shape() as Record<string, unknown> : shape as Record<string, unknown>;
}

export function schemaElement(schema: unknown): unknown {
	return schemaDef(unwrapSchema(schema)).element ?? {};
}

export function schemaType(schema: unknown): string | undefined {
	return schemaDef(unwrapSchema(schema)).type;
}

export function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

type ZodDef = {
	readonly type?: string;
	readonly innerType?: unknown;
	readonly shape?: unknown;
	readonly element?: unknown;
	readonly entries?: unknown;
};

function schemaDef(schema: unknown): ZodDef {
	if (!schema || typeof schema !== "object") return {};
	const candidate = schema as { _def?: ZodDef; def?: ZodDef };
	return candidate._def ?? candidate.def ?? {};
}
