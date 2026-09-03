import { z } from "zod";
import { artifactRefSchema } from "norn";
import { reviewDecisionSchema } from "../review/schema.ts";

export const reviewRouterParamsSchema = z.object({
	iteration: z.number().int().min(1),
	decision: reviewDecisionSchema,
	summary: z.string(),
	automatedReviewArtifact: artifactRefSchema,
});

export type ReviewRouterParams = z.output<typeof reviewRouterParamsSchema>;
