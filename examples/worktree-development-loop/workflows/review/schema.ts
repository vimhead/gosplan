import { z } from "zod";
import { workflowArtifactRefSchema } from "palantir";

export const reviewDecisionSchema = z.enum(["accept", "revise", "blocked"]);

export const reviewParamsSchema = z.object({
	task: z.string(),
	iteration: z.number().int().min(1),
});

export const reviewAgentResponseSchema = z.object({
	decision: reviewDecisionSchema,
	summary: z.string(),
});

export const storedReviewSchema = z.object({
	decision: reviewDecisionSchema,
	summary: z.string(),
	reviewArtifact: workflowArtifactRefSchema,
});

export type ReviewParams = z.output<typeof reviewParamsSchema>;
export type StoredReview = z.output<typeof storedReviewSchema>;
