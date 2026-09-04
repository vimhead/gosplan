export type NornSkillFrontmatter = Readonly<Record<string, string>> & {
	readonly name: string;
	readonly description: string;
};

export type NornSkillSummary = {
	readonly name: string;
	readonly description: string;
	readonly frontmatter: NornSkillFrontmatter;
};

export type NornSkillDetails = NornSkillSummary & {
	readonly body: string;
	readonly content: string;
};

const BUILT_IN_SKILL_CONTENTS = [
	[
		"---",
		"name: norn-workflow-observability",
		"description: Use when observing, monitoring, debugging, or explaining Norn workflow runs, including run state, manifests, artifacts, agent sessions, retries, stuck runs, and terminal outcomes.",
		"---",
		"",
		"# Norn Workflow Observability",
		"",
		"## Core workflow",
		"",
		"| Rule | GOOD | BAD |",
		"| --- | --- | --- |",
		"| IF the user asks for current Norn run status, THEN inspect the run before answering. ELSE state the source and age of any status you report. | Run norn runs inspect RUN before reporting current status. | Report a remembered status as current. |",
		"| IF two observations disagree, THEN prefer the newest canonical run inspection and verify with run files. ELSE report the single observed state. | Re-check norn runs inspect and manifest.json before explaining a mismatch. | Treat old background output and fresh inspect output as equally current. |",
		"| IF a run is active, THEN report status, health, current workflow, latest meaningful event, active command or agent, and newest artifacts. ELSE report terminal status, outcome metadata, and preserved workspace. | Say running and healthy, workflow X, latest event Y, agent Z active, artifact A created. | Say only that it is running. |",
		"| IF observation requires waiting beyond the current turn, THEN use a background wait or delayed status check and tell the user it is inspectable with /background-jobs. ELSE do not create a background job. | Start norn runs wait RUN for a long run. | Start a monitor for a one-shot inspect. |",
		"| IF a terminal run has structured metadata or artifact references, THEN read those before diagnosing the failure. ELSE diagnose from logs and manifest events. | Read outcome metadata and referenced reports before calling it a crash. | Assume every failed run is an infrastructure failure. |",
		"",
		"## Run files and state",
		"",
		"| Rule | GOOD | BAD |",
		"| --- | --- | --- |",
		"| IF the Norn CLI works, THEN use norn runs inspect RUN as the canonical status source. ELSE read the run current state file directly. | Use runs inspect to get status, health, and current workflow. | Infer status from process list alone. |",
		"| IF a run is active, THEN read recent manifest.json events to identify what changed since the last check. ELSE focus first on outcome or failure metadata. | Tail the last manifest events. | Search all logs before checking the manifest. |",
		"| IF updatedAt looks stale but a child process, session, or log is changing, THEN report active work instead of calling the run stuck. ELSE investigate a possible stall. | Compare session line count, active commands, and manifest events. | Declare a stall from unchanged updatedAt only. |",
		"| IF a background wake-up or monitor remains after the run reaches a terminal state, THEN stop redundant monitors. ELSE keep useful monitors running. | Kill a delayed status check after the main wait job finishes. | Let stale wake-ups keep notifying. |",
		"",
		"## Agent sessions",
		"",
		"| Rule | GOOD | BAD |",
		"| --- | --- | --- |",
		"| IF an agent event appears in the manifest, THEN inspect the matching session or log to see actual tool calls and results. ELSE report that no agent evidence exists yet. | Read the agent JSON log or session JSONL before summarizing agent work. | Guess from the agent label. |",
		"| IF inspecting session JSONL, THEN summarize roles, tool calls, tool results, and errors without dumping hidden or irrelevant payloads. ELSE use targeted reads. | Print line number, role, tool name, and error flag. | Paste entire JSONL entries including reasoning blobs. |",
		"| IF verifying that a capability, tool, or extension was available, THEN require a successful session event or tool result proving it. ELSE state it is unverified. | Cite a successful loader or tool result. | Assume availability because configuration exists. |",
		"| IF a tool call failed, THEN separate the tool failure from workflow failure and quote the actionable error. ELSE summarize successful calls by their effect. | Say tool X failed with error Y while run status remains healthy. | Say the workflow failed when only an inspect helper failed. |",
		"",
		"## Artifacts and reports",
		"",
		"| Rule | GOOD | BAD |",
		"| --- | --- | --- |",
		"| IF outcome metadata references artifacts, THEN read the referenced artifacts before summarizing conclusions. ELSE list that no artifact is available. | Read artifacts named in metadata. | Infer conclusions from artifact file names. |",
		"| IF a workflow creates verification or decision reports, THEN summarize the report verdict and evidence. ELSE use manifest command exits and logs. | Say report PASS with command exits. | Say looks good without evidence. |",
		"| IF reporting a retry, loop, or branch decision, THEN read the artifact or log produced by the decision workflow. ELSE explain only that a transition occurred. | Say transitioned back because report says finding X remains. | Say it retried for some reason. |",
		"| IF logs are large, THEN extract the failing command, exit code, and matched error lines. ELSE avoid pasting long warnings or noise. | Quote the assertion or stack frame that caused failure. | Paste thousands of lines of coverage or warnings. |",
		"",
		"## Debugging active or stuck runs",
		"",
		"| Rule | GOOD | BAD |",
		"| --- | --- | --- |",
		"| IF a run appears stuck, THEN check canonical status, latest manifest event, active processes, session growth, command logs, and file changes. ELSE do not call it stuck. | Compare process list, session line counts, and latest command log. | Use elapsed time alone. |",
		"| IF a command is currently running, THEN identify its label, cwd, command, elapsed time, and log paths. ELSE inspect the next most recent command result. | Report active command label and log file. | Say something is running. |",
		"| IF a workflow loops to the same workflow or a previous workflow, THEN identify the failed decision or check that triggered the loop. ELSE avoid speculating. | Read the previous verification report. | Blame the agent without evidence. |",
		"| IF the run is healthy but an external dependency failed, THEN distinguish transient infrastructure or setup failure from workflow logic failure. ELSE report the exact blocker. | Say dependency download timed out while run recovery is possible. | Say workflow implementation is broken. |",
		"",
		"## Recovery and safety",
		"",
		"| Rule | GOOD | BAD |",
		"| --- | --- | --- |",
		"| IF the user only asks to observe or explain, THEN do not edit files, stage, commit, push, deploy, stop runs, or alter remotes. ELSE act only after explicit authorization. | Inspect files and report status. | Modify the workspace while giving a status update. |",
		"| IF recovery is needed, THEN inspect available Norn recovery commands and state before suggesting rollback, resume, or restart. ELSE avoid recovery advice. | Check run state and available checkpoints first. | Tell the user to delete run files. |",
		"| IF a run preserves dirty workspace on failure, THEN point to the workspace and artifacts instead of cleaning them. ELSE leave data untouched. | Report the current workspace as preserved evidence. | Delete logs or workspace to clean up. |",
		"| IF a monitor job is redundant or stale, THEN stop only that monitor job and state it does not affect the Norn run. ELSE leave active workflow jobs alone. | Kill a delayed wake-up after the run ended. | Kill the run executor while trying to stop notifications. |",
		"",
		"## Reporting format",
		"",
		"| Rule | GOOD | BAD |",
		"| --- | --- | --- |",
		"| IF reporting current status, THEN include concrete evidence paths or event names. ELSE say what evidence is missing. | Say status from runs inspect and latest event from manifest.json. | Say seems fine. |",
		"| IF reporting progress over time, THEN compare observable deltas. ELSE report a single snapshot. | Say session grew from 20 to 45 lines and new artifact X exists. | Say it is still thinking. |",
		"| IF reporting terminal outcome, THEN include status, workflow, reason, key artifacts, and next decision needed. ELSE do not bury the reason in logs. | Say failed in workflow X, reason Y, artifact Z has details. | Say it failed, check logs. |",
		"| IF unsure, THEN state the uncertainty and the next specific file or command that would resolve it. ELSE do not speculate. | Say unclear whether command is active, then check process list and command log. | Say probably hung. |",
	].join("\n") + "\n",
];

const NORN_SKILLS = BUILT_IN_SKILL_CONTENTS.map(parseNornSkill).sort((left, right) => left.name.localeCompare(right.name));

export function listNornSkills(): readonly NornSkillSummary[] {
	return NORN_SKILLS.map((skill) => ({ name: skill.name, description: skill.description, frontmatter: skill.frontmatter }));
}

export function inspectNornSkill(name: string): NornSkillDetails | undefined {
	return NORN_SKILLS.find((skill) => skill.name === name);
}

function parseNornSkill(content: string): NornSkillDetails {
	const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(content);
	if (!match) throw new Error("Built-in Norn skill is missing frontmatter");
	const frontmatter = parseSkillFrontmatter(match[1]);
	return { name: frontmatter.name, description: frontmatter.description, frontmatter, body: match[2], content };
}

function parseSkillFrontmatter(text: string): NornSkillFrontmatter {
	const frontmatter: Record<string, string> = {};
	for (const line of text.split("\n")) {
		const trimmed = line.trim();
		if (trimmed.length === 0) continue;
		const separatorIndex = trimmed.indexOf(":");
		if (separatorIndex === -1) throw new Error(`Invalid built-in Norn skill frontmatter line: ${trimmed}`);
		frontmatter[trimmed.slice(0, separatorIndex).trim()] = unquoteFrontmatterValue(trimmed.slice(separatorIndex + 1).trim());
	}
	if (typeof frontmatter.name !== "string" || frontmatter.name.length === 0) throw new Error("Built-in Norn skill frontmatter is missing name");
	if (typeof frontmatter.description !== "string" || frontmatter.description.length === 0) throw new Error("Built-in Norn skill frontmatter is missing description");
	return frontmatter as NornSkillFrontmatter;
}

function unquoteFrontmatterValue(value: string): string {
	if (value.length < 2) return value;
	const quote = value[0];
	return (quote === '"' || quote === "'") && value[value.length - 1] === quote ? value.slice(1, -1) : value;
}
