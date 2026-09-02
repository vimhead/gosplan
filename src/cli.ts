import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { findPalantirProject, loadPalantirProject } from "./plugin-loader.ts";
import { type PalantirAnyWorkflowDeclaration, type DeletedPalantirRunInfo, type PalantirProjectInfo, type PalantirRunInfo } from "./api.ts";
import { PalantirEngine } from "./internal/engine.ts";
import { errorMessage, isNodeError } from "./internal/errors.ts";
import { readRunLaunchRequest, readRunResumeRequest, writeRunLaunchRequest, writeRunResumeRequest } from "./internal/launch-request.ts";
import { generateRunName } from "./internal/run-names.ts";
import { getRunLeaseOwner } from "./internal/run-lease.ts";
import { PalantirRunStore } from "./internal/run-store.ts";
import { readRunMetrics } from "./internal/metrics.ts";
import { getRunInfo, listRuns, resolveRunRoot } from "./internal/run-state.ts";

const RUNS_ROOT = join(".palantir", "runs");
const RUN_WAIT_INTERVAL_MS = 1000;

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
		id: "project.inspect",
		path: ["project", "inspect"],
		description: "Use when discovering the active Palantir project config, plugins, workflow sources, and Seer mode.",
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
			writeJson({ runs: await listRuns(process.cwd()) });
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
			const runRoot = await resolveRunRoot(process.cwd(), run);
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
			const runRoot = await resolveRunRoot(process.cwd(), run);
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
		id: "version",
		path: ["version"],
		description: "Use when checking the installed Palantir CLI version.",
		usage: "palantir version",
		output: "JSON object with package version under version.",
		examples: ["palantir version", "palantir --version"],
		execute: async (args) => {
			assertNoExtraArgs("version", args);
			writeJson({ version: await readPackageVersion() });
		},
	},
];

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
		writeJson({ version: await readPackageVersion() });
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
		writeJson({ help: { type: "command", command: cliCommandInfo(command) } });
		return;
	}
	const groupCommands = sortedCommandsByPath(visibleCommands().filter((candidate) => path.length === 0 || startsWithPath(candidate.path, path)));
	if (groupCommands.length === 0) throw new Error(`Unknown palantir help topic: ${path.join(" ")}`);
	writeJson({
		help: {
			type: "group",
			path,
			usage: groupHelpUsage(path),
			commands: groupCommands.map(cliCommandInfo),
			commandMetadata: {
				list: "palantir commands list",
				inspect: "palantir commands inspect <command-id>",
			},
		},
	});
}

function groupHelpUsage(path: readonly string[]): readonly string[] {
	const prefix = path.length === 0 ? "palantir" : `palantir ${path.join(" ")}`;
	return [path.length === 0 ? "palantir <command> [args]" : `${prefix} <command> [args]`, `${prefix} --help`, "palantir --version"];
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

function sortedCommandsByPath(commands: readonly CliCommand[]): readonly CliCommand[] {
	return [...commands].sort((left, right) => left.path.join(" ").localeCompare(right.path.join(" ")));
}

function visibleCommands(): readonly CliCommand[] {
	return COMMANDS.filter((command) => !command.hidden);
}

function startsWithPath(value: readonly string[], path: readonly string[]): boolean {
	return path.every((segment, index) => value[index] === segment);
}

async function readPackageVersion(): Promise<string> {
	const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8")) as { version?: unknown };
	if (typeof packageJson.version !== "string") throw new Error("Invalid Palantir package version");
	return packageJson.version;
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

async function inspectProject(): Promise<void> {
	const project = await loadPalantirProject(process.cwd());
	writeJson({ project: projectInfo(project) });
}

function projectInfo(project: Awaited<ReturnType<typeof loadPalantirProject>>): PalantirProjectInfo {
	return {
		cwd: project.cwd,
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
	const name = generateRunName(new Set((await listRuns(process.cwd())).map((run) => run.name)));
	const runRoot = resolve(process.cwd(), RUNS_ROOT, id);
	await mkdir(runRoot, { recursive: true });
	const createdAt = new Date().toISOString();
	await writeRunLaunchRequest(runRoot, { version: 1, type: "run", id, name, workflowId, params, configOverride, createdAt });
	startDetachedExecuteRun(id);
	writeJson({ run: startedRunInfo({ id, name, workflow, runRoot, createdAt }) });
}

async function resumeRun(run: string, args: readonly string[]): Promise<void> {
	assertNoStructuredInputArgs("runs resume", args);
	const runRoot = await resolveRunRoot(process.cwd(), run);
	const runInfo = await getRunInfo(runRoot);
	const input = parseResumeRunInput(await readStdinJson());
	const params = await parseResumeParams(runInfo, input.params);
	await writeRunResumeRequest(runRoot, { version: 1, type: "resume", id: runInfo.id, params, createdAt: new Date().toISOString() });
	startDetachedExecuteRun(runInfo.id);
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
	writeJson({ run: await waitForInactiveRun(run) });
}

async function waitForInactiveRun(run: string): Promise<PalantirRunInfo> {
	let runRoot: string | undefined;
	while (true) {
		runRoot ??= await resolveWaitableRunRoot(process.cwd(), run);
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

async function executeRun(runId: string): Promise<void> {
	const abortController = new AbortController();
	process.once("SIGTERM", () => abortController.abort(new Error("Stopped by user")));
	process.once("SIGINT", () => abortController.abort(new Error("Interrupted")));
	const runRoot = resolve(process.cwd(), RUNS_ROOT, runId);
	const project = await loadPalantirProject(process.cwd());
	const engine = new PalantirEngine({ cwd: process.cwd(), signal: abortController.signal, gateMode: "pause", config: project.projectConfig });
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
	const runRoot = await resolveRunRoot(process.cwd(), run);
	const engine = new PalantirEngine({ cwd: process.cwd(), gateMode: "pause" });
	writeJson({ run: await engine.rollbackRun(runRoot, checkpointId) });
}

async function inspectRun(run: string): Promise<PalantirRunInfo> {
	return readRunInspection(await resolveRunRoot(process.cwd(), run));
}

async function readRunInspection(runRoot: string): Promise<PalantirRunInfo> {
	return getRunInfo(runRoot);
}

async function signalRun(run: string, signal: NodeJS.Signals): Promise<void> {
	const runRoot = await resolveRunRoot(process.cwd(), run);
	await terminateRun(runRoot, signal);
	writeJson({ run: await getRunInfo(runRoot) });
}

async function deleteRun(run: string): Promise<DeletedPalantirRunInfo> {
	const runRoot = await resolveRunRoot(process.cwd(), run);
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
	const runRoot = await resolveRunRoot(process.cwd(), run);
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

function startDetachedExecuteRun(runId: string): void {
	const child = spawn(process.execPath, [process.argv[1] ?? "", "execute-run", runId], {
		cwd: process.cwd(),
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
