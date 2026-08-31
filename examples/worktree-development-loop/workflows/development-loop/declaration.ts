import type { PalantirWorkflowDefinition } from "palantir";
import { developmentLoopParamsSchema } from "./schema.ts";

export const developmentLoopWorkflow = {
	title: "Workspace development loop",
	isEntrypoint: true,
	description: "Plan once, then loop implementation and review in a workspace repository copy. Call this when a repository task should run through planning, implementation, and review.",
	params: developmentLoopParamsSchema,
} as const satisfies PalantirWorkflowDefinition;
