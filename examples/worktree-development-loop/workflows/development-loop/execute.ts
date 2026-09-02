import type { NornRunNext, NornRun } from "norn";
import { worktreeDevelopmentLoopManifest } from "../../manifest.ts";
import type { DevelopmentLoopConfig, DevelopmentLoopParams } from "./schema.ts";
import { materializeWorkspaceRepository } from "./repository.ts";

export async function executeDevelopmentLoopWorkflow(
	run: NornRun,
	params: DevelopmentLoopParams,
	config: DevelopmentLoopConfig,
): Promise<NornRunNext> {
	const repositoryPath = await materializeWorkspaceRepository(run, config.repositoryRoot, params.baseRef);
	await run.state.set(worktreeDevelopmentLoopManifest.states.developmentLoop.repositoryPath, repositoryPath);
	await run.state.set(worktreeDevelopmentLoopManifest.states.developmentLoop.task, params.task);
	await run.state.set(worktreeDevelopmentLoopManifest.states.developmentLoop.maxIterations, params.maxIterations);
	await run.state.set(worktreeDevelopmentLoopManifest.states.developmentLoop.currentIteration, 1);

	return run.next(worktreeDevelopmentLoopManifest.workflows.planning, { task: params.task });
}
