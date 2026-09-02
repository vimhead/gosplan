import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findPalantirProject, loadPalantirProject, PALANTIR_CONFIG_FILE_NAME, PALANTIR_PROJECT_FILE_NAME } from "./plugin-loader.ts";
import { type PalantirAnyWorkflowDeclaration, type DeletedPalantirRunInfo, type PalantirProjectInfo, type PalantirRunInfo } from "./api.ts";
import { PalantirEngine } from "./internal/engine.ts";
import { errorMessage, isNodeError } from "./internal/errors.ts";
import { readRunLaunchRequest, readRunResumeRequest, writeRunLaunchRequest, writeRunResumeRequest } from "./internal/launch-request.ts";
import { generateRunName } from "./internal/run-names.ts";
import { getRunLeaseOwner } from "./internal/run-lease.ts";
import { PalantirRunStore } from "./internal/run-store.ts";
import { readRunMetrics } from "./internal/metrics.ts";
import { getRunInfo, listRuns, resolveRunRoot } from "./internal/run-state.ts";
import { PALANTIR_BUILD_INFO, type PalantirBuildInfo, type PalantirGithubReleaseBinaryBuildInfo, type PalantirNpmGitGlobalBuildInfo } from "./build-info.ts";

const RUNS_ROOT = join(".palantir", "runs");
const RUN_WAIT_INTERVAL_MS = 1000;
const CLI_DESCRIPTION = "Palantir runs typed, resumable workflows for coding agents. Use this JSON-native CLI to discover workflows, start or resume runs, inspect evidence, and manage the installed binary.";

const COMMANDS: readonly CliCommand[] = [
	{
		id: "commands.list",
		path: ["commands", "list"],
		description: "Use when an agent or human needs machine-readable Palantir CLI command metadata.",
		usage: "palantir commands list [--all]",
		options: ["--all: include hidden internal commands"],
		output: "JSON object with command metadata under commands.",
		examples: ["palantir commands list", "palantir commands list --all"],
		execute: listCliCommands,
	},
	{
		id: "commands.inspect",
		path: ["commands", "inspect"],
		description: "Use when an agent or human needs the usage contract for one Palantir CLI command.",
		usage: "palantir commands inspect <command-id>",
		arguments: ["command-id: command metadata id such as runs.start"],
		output: "JSON object with one command metadata object under command.",
		examples: ["palantir commands inspect runs.start"],
		execute: inspectCliCommand,
	},
	{
		id: "help",
		path: ["help"],
		description: "Use when reading JSON help for all Palantir commands, one command group, or one command.",
		usage: "palantir help [command-or-group]",
		arguments: ["command-or-group: optional command path such as runs or runs start"],
		output: "JSON object with help metadata under help.",
		examples: ["palantir help", "palantir help runs", "palantir help runs start", "palantir --help"],
		execute: (args) => writeCliHelp(args),
	},
	{
		id: "project.init",
		path: ["project", "init"],
		description: "Use when creating a Palantir project marker and local run state directory in the current directory.",
		usage: "palantir project init",
		output: "JSON object with initialized project metadata under project.",
		examples: ["palantir project init"],
		execute: async (args) => {
			assertNoExtraArgs("project init", args);
			await initProject();
		},
	},
	{
		id: "project.inspect",
		path: ["project", "inspect"],
		description: "Use when discovering the active Palantir project, plugins, workflow sources, and Seer mode.",
		usage: "palantir project inspect",
		output: "JSON object with project metadata under project.",
		examples: ["palantir project inspect"],
		execute: async (args) => {
			assertNoExtraArgs("project inspect", args);
			await inspectProject();
		},
	},
	{
		id: "seer.inspect",
		path: ["seer", "inspect"],
		description: "Use when checking the current project's resolved Seer mode before agent execution.",
		usage: "palantir seer inspect",
		output: "JSON object with resolved Seer mode under seerMode.",
		examples: ["palantir seer inspect"],
		execute: async (args) => {
			assertNoExtraArgs("seer inspect", args);
			await inspectSeerMode();
		},
	},
	{
		id: "workflows.list",
		path: ["workflows", "list"],
		description: "Use when selecting a Palantir workflow for a user task; defaults to entrypoint workflows.",
		usage: "palantir workflows list [--entrypoints|--all]",
		options: ["--entrypoints: list entrypoint workflows", "--all: include internal workflow steps"],
		output: "JSON object with registered workflow summaries under workflows.",
		examples: ["palantir workflows list", "palantir workflows list --all"],
		execute: listWorkflows,
	},
	{
		id: "workflows.inspect",
		path: ["workflows", "inspect"],
		description: "Use when reading a workflow's params schema, gate contract, description, and source plugin before starting or editing it.",
		usage: "palantir workflows inspect <workflow-id>",
		arguments: ["workflow-id: fully qualified workflow id"],
		output: "JSON object with inspected workflow details under workflow.",
		examples: ["palantir workflows inspect example.plan"],
		execute: async (args) => {
			const workflowId = requiredArg("workflows inspect", args, 0, "workflow id");
			assertNoExtraArgs("workflows inspect", args.slice(1));
			await inspectWorkflow(workflowId);
		},
	},
	{
		id: "runs.start",
		path: ["runs", "start"],
		description: "Use when starting a Palantir workflow run after the workflow id and params are known.",
		usage: "palantir runs start <workflow-id>",
		arguments: ["workflow-id: fully qualified workflow id to start"],
		stdin: "Optional JSON object: {\"params\":{...},\"config\":{\"pluginId\":{...}}}.",
		output: "JSON object with started run info under run.",
		examples: ["printf '{\"params\":{\"task\":\"Add tests\"}}' | palantir runs start example.plan"],
		execute: async (args) => {
			const workflowId = requiredArg("runs start", args, 0, "workflow id");
			await startRun(workflowId, args.slice(1));
		},
	},
	{
		id: "runs.resume",
		path: ["runs", "resume"],
		description: "Use when resuming a stopped or interrupted Palantir run, including answering an editable gate.",
		usage: "palantir runs resume <run>",
		arguments: ["run: run id, generated name, or run path"],
		stdin: "Optional JSON object: {\"params\":{...}}. Interrupted runs require params.",
		output: "JSON object with resumed run info under run.",
		examples: ["printf '{\"params\":{\"decision\":\"accept\"}}' | palantir runs resume quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs resume", args, 0, "run");
			await resumeRun(run, args.slice(1));
		},
	},
	{
		id: "runs.wait",
		path: ["runs", "wait"],
		description: "Use when waiting for a Palantir run to finish, fail, interrupt, or become unhealthy.",
		usage: "palantir runs wait <run>",
		arguments: ["run: run id, generated name, or run path"],
		output: "JSON object with final or current run info under run.",
		examples: ["palantir runs wait quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs wait", args, 0, "run");
			assertNoExtraArgs("runs wait", args.slice(1));
			await waitRun(run);
		},
	},
	{
		id: "runs.list",
		path: ["runs", "list"],
		description: "Use when listing known Palantir runs in the current project.",
		usage: "palantir runs list",
		output: "JSON object with run summaries under runs.",
		examples: ["palantir runs list"],
		execute: async (args) => {
			assertNoExtraArgs("runs list", args);
			writeJson({ runs: await listCurrentProjectRuns() });
		},
	},
	{
		id: "runs.inspect",
		path: ["runs", "inspect"],
		description: "Use when reading status, health, current workflow, interruption, and outcome details for one Palantir run.",
		usage: "palantir runs inspect <run>",
		arguments: ["run: run id, generated name, or run path"],
		output: "JSON object with run details under run.",
		examples: ["palantir runs inspect quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs inspect", args, 0, "run");
			assertNoExtraArgs("runs inspect", args.slice(1));
			writeJson({ run: await inspectRun(run) });
		},
	},
	{
		id: "runs.checkpoints",
		path: ["runs", "checkpoints"],
		description: "Use when finding rollback points before retrying or repairing a Palantir run.",
		usage: "palantir runs checkpoints <run>",
		arguments: ["run: run id, generated name, or run path"],
		output: "JSON object with checkpoints under checkpoints.",
		examples: ["palantir runs checkpoints quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs checkpoints", args, 0, "run");
			assertNoExtraArgs("runs checkpoints", args.slice(1));
			const project = await findPalantirProject(process.cwd());
			const runRoot = await resolveRunRoot(project.projectRoot, run);
			writeJson({ checkpoints: await (await PalantirRunStore.open(runRoot)).listCheckpoints() });
		},
	},
	{
		id: "runs.metrics",
		path: ["runs", "metrics"],
		description: "Use when measuring workflow, agent, command, token, and cost totals for a Palantir run.",
		usage: "palantir runs metrics <run>",
		arguments: ["run: run id, generated name, or run path"],
		output: "JSON object with metrics under metrics.",
		examples: ["palantir runs metrics quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs metrics", args, 0, "run");
			assertNoExtraArgs("runs metrics", args.slice(1));
			const project = await findPalantirProject(process.cwd());
			const runRoot = await resolveRunRoot(project.projectRoot, run);
			writeJson({ metrics: await readRunMetrics(runRoot) });
		},
	},
	{
		id: "runs.logs",
		path: ["runs", "logs"],
		description: "Use when streaming or reading chronological JSON events for a Palantir run.",
		usage: "palantir runs logs <run> [--follow]",
		arguments: ["run: run id, generated name, or run path"],
		options: ["--follow: continue streaming until the run stops"],
		output: "JSON Lines stream of run events.",
		examples: ["palantir runs logs quiet-river-lantern", "palantir runs logs quiet-river-lantern --follow"],
		execute: async (args) => {
			const run = requiredArg("runs logs", args, 0, "run");
			const logArgs = args.slice(1);
			assertKnownFlags("runs logs", logArgs, ["--follow"]);
			await writeRunLogs(run, { follow: logArgs.includes("--follow") });
		},
	},
	{
		id: "runs.rollback",
		path: ["runs", "rollback"],
		description: "Use when restoring a Palantir run to a prior checkpoint before resuming after a fix.",
		usage: "palantir runs rollback <run> <checkpoint-id>",
		arguments: ["run: run id, generated name, or run path", "checkpoint-id: checkpoint id from runs.checkpoints"],
		output: "JSON object with rolled-back run info under run.",
		examples: ["palantir runs rollback quiet-river-lantern checkpoint-1"],
		execute: async (args) => {
			const run = requiredArg("runs rollback", args, 0, "run");
			await rollbackRun(run, args.slice(1));
		},
	},
	{
		id: "runs.stop",
		path: ["runs", "stop"],
		description: "Use when politely stopping a running Palantir execution process.",
		usage: "palantir runs stop <run>",
		arguments: ["run: run id, generated name, or run path"],
		output: "JSON object with updated run info under run.",
		examples: ["palantir runs stop quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs stop", args, 0, "run");
			assertNoExtraArgs("runs stop", args.slice(1));
			await signalRun(run, "SIGTERM");
		},
	},
	{
		id: "runs.kill",
		path: ["runs", "kill"],
		description: "Use when force-stopping a Palantir execution process that did not stop politely.",
		usage: "palantir runs kill <run>",
		arguments: ["run: run id, generated name, or run path"],
		output: "JSON object with updated run info under run.",
		examples: ["palantir runs kill quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs kill", args, 0, "run");
			assertNoExtraArgs("runs kill", args.slice(1));
			await signalRun(run, "SIGKILL");
		},
	},
	{
		id: "runs.delete",
		path: ["runs", "delete"],
		description: "Use when deleting an inactive Palantir run directory after evidence is no longer needed.",
		usage: "palantir runs delete <run>",
		arguments: ["run: run id, generated name, or run path"],
		output: "JSON object with deleted run identity under deleted.",
		examples: ["palantir runs delete quiet-river-lantern"],
		execute: async (args) => {
			const run = requiredArg("runs delete", args, 0, "run");
			assertNoExtraArgs("runs delete", args.slice(1));
			writeJson({ deleted: await deleteRun(run) });
		},
	},
	{
		id: "execute-run",
		path: ["execute-run"],
		description: "Use internally when executing a previously launched detached run request.",
		usage: "palantir execute-run <run-id>",
		arguments: ["run-id: internal run id"],
		output: "No stable stdout contract; execution state is persisted in the run directory.",
		hidden: true,
		examples: ["palantir execute-run 00000000-0000-0000-0000-000000000000"],
		execute: async (args) => {
			const runId = requiredArg("execute-run", args, 0, "run id");
			assertNoExtraArgs("execute-run", args.slice(1));
			await executeRun(runId);
		},
	},
	{
		id: "upgrade",
		path: ["upgrade"],
		description: "Use when upgrading this Palantir CLI installation according to explicit build metadata.",
		usage: "palantir upgrade [--dry-run]",
		options: ["--dry-run: report the upgrade plan without changing files or running installers"],
		output: "JSON object with upgrade status, plan, or unsupported reason under upgrade.",
		examples: ["palantir upgrade --dry-run", "palantir upgrade"],
		execute: upgradePalantir,
	},
	{
		id: "version",
		path: ["version"],
		description: "Use when checking the installed Palantir CLI version and explicit build metadata.",
		usage: "palantir version",
		output: "JSON object with package version under version and build metadata under build.",
		examples: ["palantir version", "palantir --version"],
		execute: async (args) => {
			assertNoExtraArgs("version", args);
			writeJson(await versionInfo());
		},
	},
];

const HELP_COMMAND_ORDER = [
	"commands.list",
	"commands.inspect",
	"workflows.list",
	"workflows.inspect",
	"runs.start",
	"runs.resume",
	"runs.wait",
	"runs.list",
	"runs.inspect",
	"runs.logs",
	"runs.checkpoints",
	"runs.rollback",
	"runs.metrics",
	"runs.stop",
	"runs.kill",
	"runs.delete",
	"project.init",
	"project.inspect",
	"seer.inspect",
	"upgrade",
	"version",
	"help",
];

const HUMAN_COMMAND_SUMMARIES: Readonly<Record<string, string>> = {
	"commands.list": "List machine-readable command metadata.",
	"commands.inspect": "Inspect one command's machine-readable contract.",
	"workflows.list": "List Palantir workflows.",
	"workflows.inspect": "Inspect a workflow schema and source.",
	"runs.start": "Start a workflow run.",
	"runs.resume": "Resume a stopped or interrupted run.",
	"runs.wait": "Wait for a run to stop running.",
	"runs.list": "List known runs.",
	"runs.inspect": "Inspect a run.",
	"runs.logs": "Read run event logs.",
	"runs.checkpoints": "List run rollback checkpoints.",
	"runs.rollback": "Roll back a run to a checkpoint.",
	"runs.metrics": "Inspect run metrics.",
	"runs.stop": "Stop a running run.",
	"runs.kill": "Force-stop a running run.",
	"runs.delete": "Delete an inactive run.",
	"project.init": "Create a Palantir project in the current directory.",
	"project.inspect": "Inspect the Palantir project.",
	"seer.inspect": "Inspect resolved Seer mode.",
	upgrade: "Upgrade the installed Palantir CLI.",
	version: "Print version/build info.",
	help: "Show concise command help.",
};

export async function main(args: readonly string[]): Promise<void> {
	try {
		await runCommand(args);
	} catch (error) {
		writeJson({ error: { code: errorCode(error), message: errorMessage(error) } });
		process.exitCode = 1;
	}
}

async function runCommand(args: readonly string[]): Promise<void> {
	if (args.length === 0) {
		writeCliHelp([]);
		return;
	}
	if (isVersionRequest(args)) {
		writeJson(await versionInfo());
		return;
	}
	const helpPath = cliHelpPath(args);
	if (helpPath) {
		writeCliHelp(helpPath);
		return;
	}
	const command = findCliCommand(args);
	if (!command) throw new Error(`Unknown palantir command: ${args.join(" ")}`);
	await command.execute(args.slice(command.path.length));
}

type CliCommand = {
	readonly id: string;
	readonly path: readonly string[];
	readonly description: string;
	readonly usage: string;
	readonly arguments?: readonly string[];
	readonly options?: readonly string[];
	readonly stdin?: string;
	readonly output: string;
	readonly examples: readonly string[];
	readonly hidden?: true;
	readonly execute: (args: readonly string[]) => Promise<void> | void;
};

type CliCommandInfo = Omit<CliCommand, "execute">;

async function listCliCommands(args: readonly string[]): Promise<void> {
	assertKnownFlags("commands list", args, ["--all"]);
	const shouldIncludeHidden = args.includes("--all");
	writeJson({ commands: COMMANDS.filter((command) => shouldIncludeHidden || !command.hidden).map(cliCommandInfo) });
}

async function inspectCliCommand(args: readonly string[]): Promise<void> {
	const commandId = requiredArg("commands inspect", args, 0, "command id");
	assertNoExtraArgs("commands inspect", args.slice(1));
	const command = COMMANDS.find((candidate) => candidate.id === commandId);
	if (!command) throw new Error(`Unknown palantir command id: ${commandId}`);
	writeJson({ command: cliCommandInfo(command) });
}

function cliCommandInfo(command: CliCommand): CliCommandInfo {
	return {
		id: command.id,
		path: command.path,
		description: command.description,
		usage: command.usage,
		arguments: command.arguments,
		options: command.options,
		stdin: command.stdin,
		output: command.output,
		examples: command.examples,
		hidden: command.hidden,
	};
}

function isVersionRequest(args: readonly string[]): boolean {
	return args.length === 1 && (args[0] === "--version" || args[0] === "-v");
}

function cliHelpPath(args: readonly string[]): readonly string[] | undefined {
	if (args[0] === "help") return args.slice(1);
	if (!args.includes("--help") && !args.includes("-h")) return undefined;
	return args.filter((arg) => arg !== "--help" && arg !== "-h");
}

function writeCliHelp(path: readonly string[]): void {
	const command = findExactCliCommand(path);
	if (command) {
		process.stdout.write(renderCommandHelp(command));
		return;
	}
	const groupCommands = sortedCommandsForHelp(visibleCommands().filter((candidate) => path.length === 0 || startsWithPath(candidate.path, path)));
	if (groupCommands.length === 0) throw new Error(`Unknown palantir help topic: ${path.join(" ")}`);
	process.stdout.write(renderGroupHelp(path, groupCommands));
}

function renderGroupHelp(path: readonly string[], commands: readonly CliCommand[]): string {
	return [
		"Palantir",
		"",
		CLI_DESCRIPTION,
		"",
		"Usage:",
		...groupHelpUsage(path).map((line) => `  ${line}`),
		"",
		"Commands:",
		renderCommandSummary(commands),
		"",
		"Machine-readable metadata:",
		"  palantir commands list",
		"  palantir commands inspect <command-id>",
		"",
	].join("\n");
}

function renderCommandHelp(command: CliCommand): string {
	return [
		commandHumanSummary(command),
		"",
		"Usage:",
		`  ${command.usage}`,
		"",
		"Description:",
		`  ${command.description}`,
		...(command.arguments ? helpSection("Arguments", command.arguments) : []),
		...(command.options ? helpSection("Options", command.options) : []),
		...(command.stdin ? ["", "Stdin:", `  ${command.stdin}`] : []),
		"",
		"Output:",
		`  ${command.output}`,
		...helpSection("Examples", command.examples),
		"",
	].join("\n");
}

function renderCommandSummary(commands: readonly CliCommand[]): string {
	const commandNames = commands.map((command) => command.path.join(" "));
	const width = Math.max(...commandNames.map((name) => name.length));
	return commands.map((command, index) => `  ${commandNames[index].padEnd(width)}  ${commandHumanSummary(command)}`).join("\n");
}

function helpSection(title: string, lines: readonly string[]): readonly string[] {
	return ["", `${title}:`, ...lines.map((line) => `  ${line}`)];
}

function groupHelpUsage(path: readonly string[]): readonly string[] {
	if (path.length === 0) return ["palantir <command> [args]", "palantir help <command>", "palantir --version"];
	const prefix = `palantir ${path.join(" ")}`;
	return [`${prefix} <command> [args]`, `palantir help ${path.join(" ")} <command>`, "palantir --version"];
}

function findCliCommand(args: readonly string[]): CliCommand | undefined {
	return sortedCommandsByPathLength(COMMANDS).find((command) => startsWithPath(args, command.path));
}

function findExactCliCommand(path: readonly string[]): CliCommand | undefined {
	return COMMANDS.find((command) => command.path.length === path.length && startsWithPath(command.path, path));
}

function sortedCommandsByPathLength(commands: readonly CliCommand[]): readonly CliCommand[] {
	return [...commands].sort((left, right) => right.path.length - left.path.length);
}

function sortedCommandsForHelp(commands: readonly CliCommand[]): readonly CliCommand[] {
	return [...commands].sort((left, right) => commandHelpOrder(left) - commandHelpOrder(right));
}

function commandHelpOrder(command: CliCommand): number {
	const index = HELP_COMMAND_ORDER.indexOf(command.id);
	return index === -1 ? HELP_COMMAND_ORDER.length : index;
}

function commandHumanSummary(command: CliCommand): string {
	return HUMAN_COMMAND_SUMMARIES[command.id] ?? command.description;
}

function visibleCommands(): readonly CliCommand[] {
	return COMMANDS.filter((command) => !command.hidden);
}

function startsWithPath(value: readonly string[], path: readonly string[]): boolean {
	return path.every((segment, index) => value[index] === segment);
}

async function versionInfo(): Promise<{ readonly version: string; readonly build: PalantirBuildInfo }> {
	return { version: await readPackageVersion(), build: PALANTIR_BUILD_INFO };
}

async function readPackageVersion(): Promise<string> {
	try {
		const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
		if (typeof packageJson.version !== "string") throw new Error("Invalid Palantir package version");
		return packageJson.version;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return PALANTIR_BUILD_INFO.version;
		throw error;
	}
}

async function upgradePalantir(args: readonly string[]): Promise<void> {
	assertKnownFlags("upgrade", args, ["--dry-run"]);
	const dryRun = args.includes("--dry-run");
	const currentVersion = await readPackageVersion();
	const build = PALANTIR_BUILD_INFO;
	if (build.kind === "unknown") {
		writeJson({ upgrade: unsupportedUpgrade(build, currentVersion, build.upgrade.reason) });
		return;
	}
	if (build.kind === "npm-git-global") {
		writeJson({ upgrade: await upgradeNpmGitGlobal(build, currentVersion, dryRun) });
		return;
	}
	writeJson({ upgrade: await upgradeGithubReleaseBinary(build, currentVersion, dryRun) });
}

function unsupportedUpgrade(build: PalantirBuildInfo, currentVersion: string, reason: string): Record<string, unknown> {
	return {
		supported: false,
		kind: build.kind,
		currentVersion,
		buildVersion: build.version,
		reason,
	};
}

async function upgradeNpmGitGlobal(build: PalantirNpmGitGlobalBuildInfo, currentVersion: string, dryRun: boolean): Promise<Record<string, unknown>> {
	const plan = {
		supported: true,
		kind: build.kind,
		dryRun,
		currentVersion,
		buildVersion: build.version,
		command: build.upgradeCommand,
	};
	if (dryRun) return { ...plan, status: "planned" };
	const result = await runCapturedCommand(build.upgradeCommand);
	return { ...plan, status: "completed", result };
}

async function upgradeGithubReleaseBinary(build: PalantirGithubReleaseBinaryBuildInfo, currentVersion: string, dryRun: boolean): Promise<Record<string, unknown>> {
	const plan = githubReleaseBinaryUpgradePlan(build, currentVersion, dryRun);
	if (dryRun) return { ...plan, status: "planned" };
	if (process.platform === "win32") return unsupportedUpgrade(build, currentVersion, "Replacing a running Windows executable is not supported yet.");
	const binary = await downloadReleaseAsset(plan.downloadUrl);
	const checksumText = await downloadReleaseText(plan.checksumUrl);
	const expectedChecksum = parseSha256Checksum(checksumText, build.checksumAssetName);
	const actualChecksum = createHash("sha256").update(Buffer.from(binary)).digest("hex");
	if (actualChecksum !== expectedChecksum) throw new Error(`Downloaded Palantir binary checksum mismatch: expected ${expectedChecksum}, got ${actualChecksum}`);
	const tempPath = join(dirname(plan.targetPath), `.palantir-upgrade-${process.pid}-${build.assetName}`);
	try {
		await writeFile(tempPath, binary);
		await chmod(tempPath, 0o755);
		await rename(tempPath, plan.targetPath);
	} catch (error) {
		await rm(tempPath, { force: true });
		throw error;
	}
	return { ...plan, status: "completed", checksum: actualChecksum };
}

function githubReleaseBinaryUpgradePlan(build: PalantirGithubReleaseBinaryBuildInfo, currentVersion: string, dryRun: boolean): {
	readonly supported: true;
	readonly kind: "github-release-binary";
	readonly dryRun: boolean;
	readonly currentVersion: string;
	readonly buildVersion: string;
	readonly repository: string;
	readonly releaseTag: string;
	readonly assetName: string;
	readonly checksumAssetName: string;
	readonly downloadUrl: string;
	readonly checksumUrl: string;
	readonly targetPath: string;
} {
	return {
		supported: true,
		kind: build.kind,
		dryRun,
		currentVersion,
		buildVersion: build.version,
		repository: build.repository,
		releaseTag: build.releaseTag,
		assetName: build.assetName,
		checksumAssetName: build.checksumAssetName,
		downloadUrl: githubReleaseDownloadUrl(build, build.assetName),
		checksumUrl: githubReleaseDownloadUrl(build, build.checksumAssetName),
		targetPath: process.execPath,
	};
}

function githubReleaseDownloadUrl(build: PalantirGithubReleaseBinaryBuildInfo, assetName: string): string {
	return `https://github.com/${build.repository}/releases/download/${build.releaseTag}/${assetName}`;
}

async function downloadReleaseAsset(url: string): Promise<Uint8Array> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to download Palantir release asset: ${url} returned ${response.status}`);
	return new Uint8Array(await response.arrayBuffer());
}

async function downloadReleaseText(url: string): Promise<string> {
	const response = await fetch(url);
	if (!response.ok) throw new Error(`Failed to download Palantir release metadata: ${url} returned ${response.status}`);
	return response.text();
}

function parseSha256Checksum(text: string, checksumAssetName: string): string {
	const checksum = text.trim().split(/\s+/)[0] ?? "";
	if (!/^[a-f0-9]{64}$/i.test(checksum)) throw new Error(`Invalid Palantir checksum asset: ${checksumAssetName}`);
	return checksum.toLowerCase();
}

async function runCapturedCommand(command: readonly string[]): Promise<{ readonly command: readonly string[]; readonly exitCode: number | null; readonly stdout: string; readonly stderr: string }> {
	const executable = requiredArg("upgrade command", command, 0, "executable");
	return new Promise((resolvePromise, reject) => {
		const child = spawn(executable, command.slice(1), { stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout?.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (exitCode) => {
			if (exitCode === 0) resolvePromise({ command, exitCode, stdout, stderr });
			else reject(new Error(stderr || `Upgrade command exited with code ${exitCode}`));
		});
	});
}

function requiredArg(command: string, args: readonly string[], index: number, label: string): string {
	const value = args[index];
	if (!value) throw new Error(`Missing ${label} for ${command}`);
	return value;
}

function assertNoExtraArgs(command: string, args: readonly string[]): void {
	if (args.length > 0) throw new Error(`${command} does not accept CLI arguments: ${args.join(" ")}`);
}

function assertKnownFlags(command: string, args: readonly string[], flags: readonly string[]): void {
	const allowedFlags = new Set(flags);
	const unsupportedFlags = args.filter((arg) => !allowedFlags.has(arg));
	if (unsupportedFlags.length > 0) throw new Error(`${command} has unsupported flags or arguments: ${unsupportedFlags.join(" ")}`);
}

async function listWorkflows(args: readonly string[]): Promise<void> {
	assertKnownFlags("workflows list", args, ["--entrypoints", "--all"]);
	const project = await loadPalantirProject(process.cwd());
	writeJson({ workflows: project.registry.list({ entrypointsOnly: workflowListEntrypointsOnly(args) }) });
}

async function inspectWorkflow(workflowId: string): Promise<void> {
	const project = await loadPalantirProject(process.cwd());
	const workflow = project.registry.inspect(workflowId);
	if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
	writeJson({ workflow });
}

function workflowListEntrypointsOnly(args: readonly string[]): boolean {
	const entrypoints = args.includes("--entrypoints");
	const all = args.includes("--all");
	if (entrypoints && all) throw new Error("Use either --entrypoints or --all, not both");
	return !all;
}

async function initProject(): Promise<void> {
	const projectRoot = process.cwd();
	const projectPath = resolve(projectRoot, PALANTIR_PROJECT_FILE_NAME);
	if (await isFile(projectPath)) throw new Error(`Palantir project already exists: ${projectPath}`);
	await mkdir(resolve(projectRoot, RUNS_ROOT), { recursive: true });
	const includes = await defaultProjectIncludes(projectRoot);
	await writeFile(projectPath, `${JSON.stringify({ version: 1, includes, config: {} }, null, 2)}\n`, "utf8");
	await ensureGitignoreExcludesRunState(projectRoot);
	writeJson({ project: { path: projectPath, root: projectRoot, runsRoot: resolve(projectRoot, RUNS_ROOT) } });
}

async function defaultProjectIncludes(projectRoot: string): Promise<readonly string[]> {
	return await isFile(resolve(projectRoot, PALANTIR_CONFIG_FILE_NAME)) ? [`./${PALANTIR_CONFIG_FILE_NAME}`] : [];
}

async function listCurrentProjectRuns(): Promise<PalantirRunInfo[]> {
	const project = await findPalantirProject(process.cwd());
	return listRuns(project.projectRoot);
}

async function inspectProject(): Promise<void> {
	const project = await loadPalantirProject(process.cwd());
	writeJson({ project: projectInfo(project) });
}

function projectInfo(project: Awaited<ReturnType<typeof loadPalantirProject>>): PalantirProjectInfo {
	return {
		cwd: project.cwd,
		projectPath: project.projectPath,
		projectRoot: project.projectRoot,
		configPath: project.configPath,
		configRoot: project.configRoot,
		configFiles: project.configFiles.map((configFile) => configFile.path),
		plugins: project.pluginInfos,
		seerMode: project.seerMode ?? null,
	};
}

async function inspectSeerMode(): Promise<void> {
	const project = await findPalantirProject(process.cwd());
	writeJson({ seerMode: project.seerMode ?? null });
}

async function startRun(workflowId: string, args: readonly string[]): Promise<void> {
	assertNoStructuredInputArgs("runs start", args);
	const project = await loadPalantirProject(process.cwd());
	const workflow = project.registry.workflowById(workflowId);
	if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
	const input = parseStartRunInput(await readStdinJson());
	const params = workflow.params.parse(input.params ?? {});
	const configOverride = input.config;
	const id = randomUUID();
	const name = generateRunName(new Set((await listRuns(project.projectRoot)).map((run) => run.name)));
	const runRoot = resolve(project.projectRoot, RUNS_ROOT, id);
	await mkdir(runRoot, { recursive: true });
	const createdAt = new Date().toISOString();
	await writeRunLaunchRequest(runRoot, { version: 1, type: "run", id, name, workflowId, params, configOverride, createdAt });
	startDetachedExecuteRun(id, project.projectRoot);
	writeJson({ run: startedRunInfo({ id, name, workflow, runRoot, createdAt }) });
}

async function resumeRun(run: string, args: readonly string[]): Promise<void> {
	assertNoStructuredInputArgs("runs resume", args);
	const project = await loadPalantirProject(process.cwd());
	const runRoot = await resolveRunRoot(project.projectRoot, run);
	const runInfo = await getRunInfo(runRoot);
	const input = parseResumeRunInput(await readStdinJson());
	const params = await parseResumeParams(runInfo, input.params);
	await writeRunResumeRequest(runRoot, { version: 1, type: "resume", id: runInfo.id, params, createdAt: new Date().toISOString() });
	startDetachedExecuteRun(runInfo.id, project.projectRoot);
	writeJson({ run: { ...runInfo, status: "running", health: "healthy", interruption: undefined, updatedAt: new Date().toISOString() } });
}

async function parseResumeParams(runInfo: PalantirRunInfo, params: unknown): Promise<unknown> {
	if (runInfo.status === "interrupted" && params === undefined) throw new Error(`Interrupted workflow resume requires params: ${runInfo.name}`);
	if (params === undefined) return undefined;
	if (!runInfo.currentWorkflowId) throw new Error(`Run has no current workflow: ${runInfo.name}`);
	const project = await loadPalantirProject(process.cwd());
	const workflow = project.registry.workflowById(runInfo.currentWorkflowId);
	if (!workflow) throw new Error(`Unknown workflow for resumed run: ${runInfo.currentWorkflowId}`);
	return workflow.params.parse(params);
}

async function waitRun(run: string): Promise<void> {
	const project = await findPalantirProject(process.cwd());
	writeJson({ run: await waitForInactiveRun(project.projectRoot, run) });
}

async function waitForInactiveRun(projectRoot: string, run: string): Promise<PalantirRunInfo> {
	let runRoot: string | undefined;
	while (true) {
		runRoot ??= await resolveWaitableRunRoot(projectRoot, run);
		try {
			const runInfo = await readRunInspection(runRoot);
			if (runInfo.status !== "running" || runInfo.health === "unhealthy") return runInfo;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		await delay(RUN_WAIT_INTERVAL_MS);
	}
}

async function resolveWaitableRunRoot(sessionCwd: string, run: string): Promise<string> {
	try {
		return await resolveRunRoot(sessionCwd, run);
	} catch (error) {
		for (const candidate of [resolve(sessionCwd, run), resolve(sessionCwd, RUNS_ROOT, run)]) {
			if (await isDirectory(candidate)) return candidate;
		}
		throw error;
	}
}

async function isDirectory(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isDirectory();
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function isFile(path: string): Promise<boolean> {
	try {
		return (await stat(path)).isFile();
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function ensureGitignoreExcludesRunState(projectRoot: string): Promise<void> {
	const gitignorePath = resolve(projectRoot, ".gitignore");
	const runStatePattern = ".palantir/runs/";
	let currentText = "";
	try {
		currentText = await readFile(gitignorePath, "utf8");
	} catch (error) {
		if (!isNodeError(error) || error.code !== "ENOENT") throw error;
	}
	if (currentText.split(/\r?\n/).includes(runStatePattern)) return;
	const separator = currentText.length === 0 || currentText.endsWith("\n") ? "" : "\n";
	await writeFile(gitignorePath, `${currentText}${separator}${runStatePattern}\n`, "utf8");
}

async function executeRun(runId: string): Promise<void> {
	const abortController = new AbortController();
	process.once("SIGTERM", () => abortController.abort(new Error("Stopped by user")));
	process.once("SIGINT", () => abortController.abort(new Error("Interrupted")));
	const project = await loadPalantirProject(process.cwd());
	const runRoot = resolve(project.projectRoot, RUNS_ROOT, runId);
	const engine = new PalantirEngine({ cwd: project.projectRoot, signal: abortController.signal, gateMode: "pause", config: project.projectConfig });
	for (const plugin of project.plugins) engine.registerPlugin(plugin);
	const launchRequest = await readOptionalRunLaunchRequest(runRoot);
	if (launchRequest) {
		try {
			const workflow = project.registry.workflowById(launchRequest.workflowId);
			if (!workflow) throw new Error(`Unknown workflow: ${launchRequest.workflowId}`);
			await engine.runWorkflow(workflow, launchRequest.params, { id: launchRequest.id, name: launchRequest.name, configOverride: launchRequest.configOverride });
			return;
		} finally {
			await rm(join(runRoot, "launch-request.json"), { force: true });
		}
	}
	const resumeRequest = await readRunResumeRequest(runRoot);
	try {
		await engine.resumeWorkflow(runRoot, resumeRequest.params);
	} finally {
		await rm(join(runRoot, "resume-request.json"), { force: true });
	}
}

async function rollbackRun(run: string, args: readonly string[]): Promise<void> {
	const checkpointId = requiredArg("runs rollback", args, 0, "checkpoint id");
	assertNoExtraArgs("runs rollback", args.slice(1));
	const project = await findPalantirProject(process.cwd());
	const runRoot = await resolveRunRoot(project.projectRoot, run);
	const engine = new PalantirEngine({ cwd: project.projectRoot, gateMode: "pause" });
	writeJson({ run: await engine.rollbackRun(runRoot, checkpointId) });
}

async function inspectRun(run: string): Promise<PalantirRunInfo> {
	const project = await findPalantirProject(process.cwd());
	return readRunInspection(await resolveRunRoot(project.projectRoot, run));
}

async function readRunInspection(runRoot: string): Promise<PalantirRunInfo> {
	return getRunInfo(runRoot);
}

async function signalRun(run: string, signal: NodeJS.Signals): Promise<void> {
	const project = await findPalantirProject(process.cwd());
	const runRoot = await resolveRunRoot(project.projectRoot, run);
	await terminateRun(runRoot, signal);
	writeJson({ run: await getRunInfo(runRoot) });
}

async function deleteRun(run: string): Promise<DeletedPalantirRunInfo> {
	const project = await findPalantirProject(process.cwd());
	const runRoot = await resolveRunRoot(project.projectRoot, run);
	const runInfo = await getRunInfo(runRoot);
	if (runInfo.status === "running") throw new Error(`Stop run before deleting it: ${runInfo.name}`);
	await rm(runRoot, { recursive: true, force: true });
	return { id: runInfo.id, name: runInfo.name, path: runInfo.path };
}

async function terminateRun(runRoot: string, signal: NodeJS.Signals): Promise<void> {
	const owner = await getRunLeaseOwner(runRoot);
	if (!owner) return;
	sendSignal(owner.processGroupId, owner.pid, signal);
	await delay(signal === "SIGKILL" ? 250 : 1000);
}

async function writeRunLogs(run: string, options: { readonly follow: boolean }): Promise<void> {
	const project = await findPalantirProject(process.cwd());
	const runRoot = await resolveRunRoot(project.projectRoot, run);
	let written = 0;
	while (true) {
		const events = await readRunEvents(runRoot);
		for (const event of events.slice(written)) process.stdout.write(`${JSON.stringify(event)}\n`);
		written = events.length;
		if (!options.follow) return;
		const info = await getRunInfo(runRoot);
		if (info.status !== "running" && written >= events.length) return;
		await delay(1000);
	}
}

function startDetachedExecuteRun(runId: string, projectRoot: string): void {
	const child = spawn(process.execPath, [process.argv[1] ?? "", "execute-run", runId], {
		cwd: projectRoot,
		detached: true,
		stdio: "ignore",
	});
	child.unref();
}

function startedRunInfo(input: {
	readonly id: string;
	readonly name: string;
	readonly workflow: PalantirAnyWorkflowDeclaration;
	readonly runRoot: string;
	readonly createdAt: string;
}): PalantirRunInfo {
	return {
		version: 1,
		id: input.id,
		name: input.name,
		path: input.runRoot,
		entrypointWorkflowId: input.workflow.id,
		currentWorkflowId: input.workflow.id,
		status: "running",
		health: "healthy",
		startedAt: input.createdAt,
		updatedAt: input.createdAt,
	};
}

async function readOptionalRunLaunchRequest(runRoot: string) {
	try {
		return await readRunLaunchRequest(runRoot);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readRunEvents(runRoot: string): Promise<readonly Record<string, unknown>[]> {
	try {
		const manifest = JSON.parse(await readFile(join(runRoot, "current", "manifest.json"), "utf8")) as { events?: readonly Record<string, unknown>[] };
		return manifest.events ?? [];
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

async function readStdinJson(): Promise<unknown | undefined> {
	const text = await readStdin();
	const trimmed = text.trim();
	return trimmed.length === 0 ? undefined : JSON.parse(trimmed);
}

async function readStdin(): Promise<string> {
	if (process.stdin.isTTY) return "";
	return new Promise((resolvePromise, reject) => {
		let text = "";
		process.stdin.setEncoding("utf8");
		process.stdin.on("data", (chunk) => {
			text += chunk;
		});
		process.stdin.on("error", reject);
		process.stdin.on("end", () => resolvePromise(text));
		process.stdin.resume();
	});
}

function parseStartRunInput(value: unknown): { readonly params?: unknown; readonly config?: unknown } {
	if (value === undefined) return {};
	const input = parseStructuredInputObject("runs start", value);
	assertStructuredInputKeys("runs start", input, ["params", "config"]);
	return { params: input.params, config: input.config };
}

function parseResumeRunInput(value: unknown): { readonly params?: unknown } {
	if (value === undefined) return {};
	const input = parseStructuredInputObject("runs resume", value);
	assertStructuredInputKeys("runs resume", input, ["params"]);
	return { params: input.params };
}

function parseStructuredInputObject(command: string, value: unknown): Record<string, unknown> {
	if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`${command} reads a JSON object from stdin`);
	return value as Record<string, unknown>;
}

function assertStructuredInputKeys(command: string, input: Record<string, unknown>, allowedKeys: readonly string[]): void {
	const allowed = new Set(allowedKeys);
	const unexpected = Object.keys(input).filter((key) => !allowed.has(key));
	if (unexpected.length > 0) throw new Error(`${command} stdin JSON has unsupported keys: ${unexpected.join(", ")}`);
}

function assertNoStructuredInputArgs(command: string, args: readonly string[]): void {
	if (args.length > 0) throw new Error(`${command} reads structured input from stdin, not CLI arguments: ${args.join(" ")}`);
}

function sendSignal(processGroupId: number, pid: number, signal: NodeJS.Signals): void {
	try {
		if (processGroupId > 0 && process.platform !== "win32") {
			process.kill(-processGroupId, signal);
			return;
		}
	} catch (error) {
		if (!isIgnorableSignalError(error)) throw error;
	}
	try {
		process.kill(pid, signal);
	} catch (error) {
		if (!isIgnorableSignalError(error)) throw error;
	}
}

function isIgnorableSignalError(error: unknown): boolean {
	return isNodeError(error) && (error.code === "ESRCH" || error.code === "EPERM");
}

function writeJson(value: unknown): void {
	process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
}

function errorCode(error: unknown): string {
	if (error instanceof SyntaxError) return "INVALID_JSON";
	return "PALANTIR_ERROR";
}
