import type { PalantirAnyWorkflowDeclaration } from "./api.ts";

export function assertLaunchableWorkflow(workflow: PalantirAnyWorkflowDeclaration): void {
	if (!workflow.isEntrypoint) return;
	if (!workflow.title || workflow.title.trim().length === 0) throw new Error(`Entrypoint workflow requires a title: ${workflow.id}`);
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
};

function schemaDef(schema: unknown): ZodDef {
	if (!schema || typeof schema !== "object") return {};
	const candidate = schema as { _def?: ZodDef; def?: ZodDef };
	return candidate._def ?? candidate.def ?? {};
}
