import { z } from "zod";
import { workflowArtifactRefSchema } from "palantir";
import { reviewDecisionSchema } from "../review/schema.ts";

export const reviewRouterParamsSchema = z.object({
	iteration: z.number().int().min(1),
	decision: reviewDecisionSchema,
	summary: z.string(),
	automatedReviewArtifact: workflowArtifactRefSchema,
});

export type ReviewRouterParams = z.output<typeof reviewRouterParamsSchema>;
