import { z } from "zod";

export const implementationParamsSchema = z.object({
	task: z.string(),
	iteration: z.number().int().min(1),
});

export const implementationAgentResponseSchema = z.object({
	summary: z.string(),
});

export type ImplementationParams = z.output<typeof implementationParamsSchema>;
