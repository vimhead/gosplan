import { definePluginManifest } from "norn";
import { developmentLoopState, implementationState, planningState, reviewState } from "./state.ts";
import { developmentLoopWorkflow } from "./workflows/development-loop/declaration.ts";
import { developmentLoopConfigSchema } from "./workflows/development-loop/schema.ts";
import { implementationWorkflow } from "./workflows/implementation/declaration.ts";
import { planningWorkflow } from "./workflows/planning/declaration.ts";
import { reviewRouterWorkflow } from "./workflows/review-router/declaration.ts";
import { reviewWorkflow } from "./workflows/review/declaration.ts";

export const worktreeDevelopmentLoopManifest = definePluginManifest({
	id: "worktreeDevelopmentLoop",
	config: developmentLoopConfigSchema,
	workflows: {
		planning: planningWorkflow,
		implementation: implementationWorkflow,
		review: reviewWorkflow,
		reviewRouter: reviewRouterWorkflow,
		developmentLoop: developmentLoopWorkflow,
	},
	states: {
		developmentLoop: developmentLoopState,
		planning: planningState,
		implementation: implementationState,
		review: reviewState,
	},
});
