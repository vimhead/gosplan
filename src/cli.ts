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

export async function main(args: readonly string[]): Promise<void> {
	try {
		await runCommand(args);
	} catch (error) {
		writeJson({ error: { code: errorCode(error), message: errorMessage(error) } });
		process.exitCode = 1;
	}
}

async function runCommand(args: readonly string[]): Promise<void> {
	const [command, subcommand, ...rest] = args;
	if (command === "workflows" && subcommand === "list") {
		await listWorkflows(rest);
		return;
	}
	if (command === "workflows" && subcommand === "inspect" && rest[0]) {
		await inspectWorkflow(rest[0]);
		return;
	}
	if (command === "project" && subcommand === "inspect") {
		await inspectProject();
		return;
	}
	if (command === "seer" && subcommand === "inspect") {
		await inspectSeerMode();
		return;
	}
	if (command === "execute-run" && subcommand) {
		await executeRun(subcommand);
		return;
	}
	if (command === "runs" && subcommand === "start" && rest[0]) {
		await startRun(rest[0], rest.slice(1));
		return;
	}
	if (command === "runs" && subcommand === "resume" && rest[0]) {
		await resumeRun(rest[0], rest.slice(1));
		return;
	}
	if (command === "runs" && subcommand === "wait" && rest[0]) {
		await waitRun(rest[0]);
		return;
	}
	if (command === "runs" && subcommand === "rollback" && rest[0]) {
		await rollbackRun(rest[0], rest.slice(1));
		return;
	}
	if (command === "runs" && subcommand === "stop" && rest[0]) {
		await signalRun(rest[0], "SIGTERM");
		return;
	}
	if (command === "runs" && subcommand === "kill" && rest[0]) {
		await signalRun(rest[0], "SIGKILL");
		return;
	}
	if (command === "runs" && subcommand === "delete" && rest[0]) {
		writeJson({ deleted: await deleteRun(rest[0]) });
		return;
	}
	if (command === "runs" && subcommand === "list") {
		writeJson({ runs: await listRuns(process.cwd()) });
		return;
	}
	if (command === "runs" && subcommand === "inspect" && rest[0]) {
		writeJson({ run: await inspectRun(rest[0]) });
		return;
	}
	if (command === "runs" && subcommand === "checkpoints" && rest[0]) {
		const runRoot = await resolveRunRoot(process.cwd(), rest[0]);
		writeJson({ checkpoints: await (await PalantirRunStore.open(runRoot)).listCheckpoints() });
		return;
	}
	if (command === "runs" && subcommand === "metrics" && rest[0]) {
		const runRoot = await resolveRunRoot(process.cwd(), rest[0]);
		writeJson({ metrics: await readRunMetrics(runRoot) });
		return;
	}
	if (command === "runs" && subcommand === "logs" && rest[0]) {
		await writeRunLogs(rest[0], { follow: rest.includes("--follow") });
		return;
	}
	throw new Error(`Unknown palantir command: ${args.join(" ")}`);
}

async function listWorkflows(args: readonly string[]): Promise<void> {
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
	const checkpointId = args[0];
	if (!checkpointId) throw new Error("Missing checkpoint id");
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
