import { z } from "zod";

export const planningParamsSchema = z.object({
	task: z.string(),
});

export const planningAgentResponseSchema = z.object({
	plan: z.string(),
	summary: z.string(),
});

export type PlanningParams = z.output<typeof planningParamsSchema>;
