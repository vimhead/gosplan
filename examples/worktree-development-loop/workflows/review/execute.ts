import type { PalantirRunNext, PalantirRun } from "palantir";
import { worktreeDevelopmentLoopManifest } from "../../manifest.ts";
import { ensureCommandSucceeded } from "../../shared/commands.ts";
import { reviewAgentResponseSchema, type ReviewParams } from "./schema.ts";

export async function executeReviewWorkflow(run: PalantirRun, params: ReviewParams): Promise<PalantirRunNext> {
	const planArtifact = await run.state.get(worktreeDevelopmentLoopManifest.states.planning.planArtifact);
	const implementationSummary = await run.state.get(worktreeDevelopmentLoopManifest.states.implementation.implementationSummary);
	const plan = await run.artifacts.read(planArtifact);
	const diff = await run.commands.run({
		label: `review-${params.iteration}-diff`,
		command: "git status --short && git diff --stat HEAD -- . && git diff HEAD -- .",
	});
	await ensureCommandSucceeded(diff);
	const diffOutput = await run.logs.read(diff.stdoutLog);
	await run.artifacts.write(`review/iteration-${params.iteration}-diff.txt`, diffOutput);
	const agent = await run.agents.run({
		label: `review-${params.iteration}`,
		prompt: buildReviewPrompt(params.task, plan, implementationSummary, diffOutput),
		response: reviewAgentResponseSchema,
		tools: ["read", "grep", "find", "ls", "bash"],
	});
	const automatedReviewArtifact = await run.artifacts.write(`review/iteration-${params.iteration}-automated.json`, JSON.stringify(agent.response, null, 2));
	return run.next(worktreeDevelopmentLoopManifest.workflows.reviewRouter, {
		iteration: params.iteration,
		decision: agent.response.decision,
		summary: agent.response.summary,
		automatedReviewArtifact,
	});
}

function buildReviewPrompt(task: string, plan: string, implementationSummary: string, diff: string): string {
	return [
		"Review the current repository changes against the task and plan.",
		"Use accept only when the work is ready. Use revise for fixable issues. Use blocked when manual input is needed. Include review details in the summary.",
		"",
		"Task:",
		task,
		"",
		"Plan:",
		plan,
		"",
		"Implementation summary:",
		implementationSummary,
		"",
		"Diff:",
		diff.slice(0, 40_000),
	].join("\n");
}

