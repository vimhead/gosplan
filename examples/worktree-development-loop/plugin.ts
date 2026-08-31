import { definePlugin } from "palantir";
import { worktreeDevelopmentLoopManifest } from "./manifest.ts";
import { executeDevelopmentLoopWorkflow } from "./workflows/development-loop/index.ts";
import { executeImplementationWorkflow } from "./workflows/implementation/index.ts";
import { executePlanningWorkflow } from "./workflows/planning/index.ts";
import { executeReviewRouterWorkflow } from "./workflows/review-router/index.ts";
import { executeReviewWorkflow } from "./workflows/review/index.ts";

const worktreeDevelopmentLoopPlugin = definePlugin(worktreeDevelopmentLoopManifest, () => ({
	workflows: {
		planning: { execute: executePlanningWorkflow },
		implementation: { execute: executeImplementationWorkflow },
		review: { execute: executeReviewWorkflow },
		reviewRouter: {
			gate: {
				describe: async (run, params) => {
					const planArtifact = await run.state.get(worktreeDevelopmentLoopManifest.states.planning.planArtifact);
					return `Review iteration ${params.iteration}. Confirm or edit the automated decision before continuing. Plan: ${planArtifact.path}.`;
				},
			},
			execute: executeReviewRouterWorkflow,
		},
		developmentLoop: { execute: executeDevelopmentLoopWorkflow },
	},
}));

export default worktreeDevelopmentLoopPlugin;
