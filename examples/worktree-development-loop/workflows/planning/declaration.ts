import type { NornWorkflowDefinition } from "norn";
import { planningParamsSchema } from "./schema.ts";

export const planningWorkflow = {
	isEntrypoint: false,
	description: "Create an implementation plan for a repository task.",
	params: planningParamsSchema,
} as const satisfies NornWorkflowDefinition;
