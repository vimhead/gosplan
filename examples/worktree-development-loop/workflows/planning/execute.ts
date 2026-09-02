import type { NornRunNext, NornRun } from "norn";
import { worktreeDevelopmentLoopManifest } from "../../manifest.ts";
import { planningAgentResponseSchema, type PlanningParams } from "./schema.ts";

export async function executePlanningWorkflow(run: NornRun, params: PlanningParams): Promise<NornRunNext> {
	const repositoryPath = await run.state.get(worktreeDevelopmentLoopManifest.states.developmentLoop.repositoryPath);
	const agent = await run.agents.run({
		label: "planning",
		cwd: repositoryPath,
		prompt: buildPlanningPrompt(params.task),
		response: planningAgentResponseSchema,
		tools: ["read", "grep", "find", "ls"],
	});
	const planArtifact = await run.artifacts.write("planning/plan.md", agent.response.plan);
	await run.state.set(worktreeDevelopmentLoopManifest.states.planning.planArtifact, planArtifact);
	return run.next(worktreeDevelopmentLoopManifest.workflows.implementation, { task: params.task, iteration: 1 });
}

function buildPlanningPrompt(task: string): string {
	return [
		"Create a concise implementation plan for this repository task.",
		"Do not modify files in this step.",
		"Include assumptions, planned edits, and checks in the plan.",
		"",
		"Task:",
		task,
	].join("\n");
}
