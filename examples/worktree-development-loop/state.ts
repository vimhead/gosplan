import { z } from "zod";
import { workflowArtifactRefSchema, type NornWorkflowPluginStateTree } from "norn";
import { reviewDecisionSchema } from "./workflows/review/schema.ts";

export const developmentLoopState = {
	task: z.string(),
	maxIterations: z.number().int().min(1).max(10),
	currentIteration: z.number().int().min(1),
	repositoryPath: z.string(),
} as const satisfies NornWorkflowPluginStateTree;

export const planningState = {
	planArtifact: workflowArtifactRefSchema,
} as const satisfies NornWorkflowPluginStateTree;

export const implementationState = {
	implementationSummary: z.string(),
} as const satisfies NornWorkflowPluginStateTree;

export const reviewState = {
	reviewDecision: reviewDecisionSchema,
	reviewArtifact: workflowArtifactRefSchema,
} as const satisfies NornWorkflowPluginStateTree;
