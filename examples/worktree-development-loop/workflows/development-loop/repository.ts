import type { NornRun } from "norn";
import { ensureCommandSucceeded } from "../../shared/commands.ts";

const WORKSPACE_REPOSITORY_PATH = "repo";

export async function materializeWorkspaceRepository(run: NornRun, repositoryRoot: string, baseRef: string): Promise<string> {
	const repositoryPath = run.path(WORKSPACE_REPOSITORY_PATH);
	const result = await run.commands.run({
		label: "materialize-workspace-repository",
		command: [
			`rm -rf ${shellQuote(repositoryPath)}`,
			`git clone --no-checkout ${shellQuote(repositoryRoot)} ${shellQuote(repositoryPath)}`,
			`git -C ${shellQuote(repositoryPath)} checkout ${shellQuote(baseRef)}`,
		].join(" && "),
	});
	await ensureCommandSucceeded(result);
	return WORKSPACE_REPOSITORY_PATH;
}

function shellQuote(value: string): string {
	return `'${value.replaceAll("'", "'\\''")}'`;
}
