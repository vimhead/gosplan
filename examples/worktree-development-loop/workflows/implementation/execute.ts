import type { PalantirRunNext, PalantirRun } from "palantir";
import { worktreeDevelopmentLoopManifest } from "../../manifest.ts";
import { ensureCommandSucceeded } from "../../shared/commands.ts";
import { implementationAgentResponseSchema, type ImplementationParams } from "./schema.ts";

export async function executeImplementationWorkflow(
	run: PalantirRun,
	params: ImplementationParams,
): Promise<PalantirRunNext> {
	const repositoryPath = await run.state.get(worktreeDevelopmentLoopManifest.states.developmentLoop.repositoryPath);
	const planArtifact = await run.state.get(worktreeDevelopmentLoopManifest.states.planning.planArtifact);
	const plan = await run.artifacts.read(planArtifact);
	const previousReviewArtifact = await run.state.getOptional(worktreeDevelopmentLoopManifest.states.review.reviewArtifact);
	const previousReview = previousReviewArtifact ? await run.artifacts.read(previousReviewArtifact) : undefined;
	const agent = await run.agents.run({
		label: `implementation-${params.iteration}`,
		cwd: repositoryPath,
		prompt: buildImplementationPrompt(params.task, plan, params.iteration, previousReview),
		response: implementationAgentResponseSchema,
		tools: ["read", "grep", "find", "ls", "edit", "write", "bash"],
	});
	await run.state.set(worktreeDevelopmentLoopManifest.states.implementation.implementationSummary, agent.response.summary);
	const status = await run.commands.run({
		label: `implementation-${params.iteration}-status`,
		cwd: repositoryPath,
		command: "git status --short",
	});
	await ensureCommandSucceeded(status);
	const statusOutput = await run.logs.read(status.stdoutLog);
	await run.artifacts.write(`implementation/iteration-${params.iteration}-status.txt`, statusOutput);
	return run.next(worktreeDevelopmentLoopManifest.workflows.review, {
		task: params.task,
		iteration: params.iteration,
	});
}

function buildImplementationPrompt(task: string, plan: string, iteration: number, previousReview: string | undefined): string {
	return [
		`Implement iteration ${iteration} for this repository task.`,
		"Modify files as needed in the current repository.",
		"Keep changes focused and run a cheap relevant check when possible.",
		previousReview ? "Address the previous review before making new changes." : undefined,
		"",
		"Task:",
		task,
		"",
		"Plan:",
		plan,
		previousReview ? "" : undefined,
		previousReview ? "Previous review:" : undefined,
		previousReview,
	].filter((line): line is string => line !== undefined).join("\n");
}

