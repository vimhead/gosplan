import type { PalantirWorkflowDefinition } from "palantir";
import { reviewRouterParamsSchema } from "./schema.ts";

export const reviewRouterWorkflow = {
	isEntrypoint: false,
	description: "Route implementation and review iterations based on the latest review decision.",
	gate: {
		enabled: true,
		fields: ["decision", "summary"] as const,
	},
	params: reviewRouterParamsSchema,
} as const satisfies PalantirWorkflowDefinition;
