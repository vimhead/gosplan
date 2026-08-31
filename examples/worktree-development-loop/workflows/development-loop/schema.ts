import { z } from "zod";

export const developmentLoopConfigSchema = z.object({
	repositoryRoot: z.string(),
});

export const developmentLoopParamsSchema = z.object({
	task: z.string(),
	baseRef: z.string().default("HEAD"),
	maxIterations: z.number().int().min(1).max(10).default(3),
});

export type DevelopmentLoopConfig = z.output<typeof developmentLoopConfigSchema>;
export type DevelopmentLoopParams = z.output<typeof developmentLoopParamsSchema>;
