import type { NornWorkflowDefinition } from "norn";
import { implementationParamsSchema } from "./schema.ts";

export const implementationWorkflow = {
	isEntrypoint: false,
	description: "Apply one implementation pass in the current repository.",
	params: implementationParamsSchema,
} as const satisfies NornWorkflowDefinition;
