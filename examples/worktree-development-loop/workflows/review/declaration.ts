import type { NornWorkflowDefinition } from "norn";
import { reviewParamsSchema } from "./schema.ts";

export const reviewWorkflow = {
	isEntrypoint: false,
	description: "Review the current repository boundary changes.",
	params: reviewParamsSchema,
} as const satisfies NornWorkflowDefinition;
