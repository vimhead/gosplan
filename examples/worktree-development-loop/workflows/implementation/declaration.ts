import type { PalantirWorkflowDefinition } from "palantir";
import { implementationParamsSchema } from "./schema.ts";

export const implementationWorkflow = {
	isEntrypoint: false,
	description: "Apply one implementation pass in the current repository.",
	params: implementationParamsSchema,
} as const satisfies PalantirWorkflowDefinition;
