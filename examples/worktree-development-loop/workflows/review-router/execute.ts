import type { PalantirWorkflowExecutionResult, PalantirRun } from "palantir";
import { worktreeDevelopmentLoopManifest } from "../../manifest.ts";
import type { StoredReview } from "../review/schema.ts";
import type { ReviewRouterParams } from "./schema.ts";

export async function executeReviewRouterWorkflow(
	run: PalantirRun,
	params: ReviewRouterParams,
): Promise<PalantirWorkflowExecutionResult> {
	const repositoryPath = await run.state.get(worktreeDevelopmentLoopManifest.states.developmentLoop.repositoryPath);
	const planArtifact = await run.state.get(worktreeDevelopmentLoopManifest.states.planning.planArtifact);
	const currentIteration = await run.state.get(worktreeDevelopmentLoopManifest.states.developmentLoop.currentIteration);
	const maxIterations = await run.state.get(worktreeDevelopmentLoopManifest.states.developmentLoop.maxIterations);
	const task = await run.state.get(worktreeDevelopmentLoopManifest.states.developmentLoop.task);
	const reviewArtifact = await run.artifacts.write(
		`review/iteration-${params.iteration}-decision.json`,
		JSON.stringify({ decision: params.decision, summary: params.summary, automatedReviewArtifact: params.automatedReviewArtifact }, null, 2),
	);
	const lastReview: StoredReview = { decision: params.decision, summary: params.summary, reviewArtifact };

	await run.state.set(worktreeDevelopmentLoopManifest.states.review.reviewDecision, params.decision);
	await run.state.set(worktreeDevelopmentLoopManifest.states.review.reviewArtifact, reviewArtifact);

	if (params.decision === "accept") {
		return run.complete({
			summary: `Implementation accepted after ${currentIteration} iteration(s).`,
			artifacts: { plan: planArtifact, review: reviewArtifact },
			data: { status: "done", repositoryPath, iterations: currentIteration, lastReview },
		});
	}

	if (params.decision === "blocked") {
		return run.fail({
			summary: params.summary,
			artifacts: { plan: planArtifact, review: reviewArtifact },
			data: { status: "blocked", repositoryPath, iterations: currentIteration, lastReview },
		});
	}

	if (currentIteration >= maxIterations) {
		return run.fail({
			summary: `Maximum iteration count reached after ${currentIteration} iteration(s).`,
			artifacts: { plan: planArtifact, review: reviewArtifact },
			data: { status: "needs-attention", repositoryPath, iterations: currentIteration, lastReview },
		});
	}

	const nextIteration = currentIteration + 1;
	await run.state.set(worktreeDevelopmentLoopManifest.states.developmentLoop.currentIteration, nextIteration);
	return run.next(worktreeDevelopmentLoopManifest.workflows.implementation, { task, iteration: nextIteration });
}
