import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { loadPalantirProject } from "./plugin-loader.ts";
import { type AnyWorkflowDeclaration, type DeletedWorkflowRunInfo, type WorkflowRunInfo } from "./api.ts";
import { PalantirRuntime } from "./internal/session-runtime.ts";
import { errorMessage, isNodeError } from "./internal/errors.ts";
import { readWorkflowLaunchRequest, readWorkflowResumeRequest, writeWorkflowLaunchRequest, writeWorkflowResumeRequest } from "./internal/launch-request.ts";
import { generateWorkflowRunName } from "./internal/run-names.ts";
import { getWorkflowRunLeaseOwner } from "./internal/run-lease.ts";
import { WorkflowRunStore } from "./internal/run-store.ts";
import { getWorkflowRunInfo, listWorkflowRuns, resolveWorkflowRunRoot } from "./internal/runtime-state.ts";

const RUNS_ROOT = join(".palantir", "runs");

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
		await listWorkflows();
		return;
	}
	if (command === "execute-run" && subcommand) {
		await executeWorkflowRun(subcommand);
		return;
	}
	if (command === "runs" && subcommand === "start" && rest[0]) {
		await startWorkflowRun(rest[0], rest.slice(1));
		return;
	}
	if (command === "runs" && subcommand === "resume" && rest[0]) {
		await resumeWorkflowRun(rest[0], rest.slice(1));
		return;
	}
	if (command === "runs" && subcommand === "rollback" && rest[0]) {
		await rollbackWorkflowRun(rest[0], rest.slice(1));
		return;
	}
	if (command === "runs" && subcommand === "stop" && rest[0]) {
		await signalWorkflowRun(rest[0], "SIGTERM");
		return;
	}
	if (command === "runs" && subcommand === "kill" && rest[0]) {
		await signalWorkflowRun(rest[0], "SIGKILL");
		return;
	}
	if (command === "runs" && subcommand === "delete" && rest[0]) {
		writeJson({ deleted: await deleteWorkflowRun(rest[0]) });
		return;
	}
	if (command === "runs" && subcommand === "list") {
		writeJson({ runs: await listWorkflowRuns(process.cwd()) });
		return;
	}
	if (command === "runs" && subcommand === "inspect" && rest[0]) {
		writeJson({ run: await inspectWorkflowRun(rest[0]) });
		return;
	}
	if (command === "runs" && subcommand === "checkpoints" && rest[0]) {
		const runRoot = await resolveWorkflowRunRoot(process.cwd(), rest[0]);
		writeJson({ checkpoints: await (await WorkflowRunStore.open(runRoot)).listCheckpoints() });
		return;
	}
	if (command === "runs" && subcommand === "human-gate" && rest[0]) {
		await inspectWorkflowRunHumanGate(rest[0]);
		return;
	}
	if (command === "runs" && subcommand === "logs" && rest[0]) {
		await writeWorkflowRunLogs(rest[0], { follow: rest.includes("--follow") });
		return;
	}
	throw new Error(`Unknown palantir command: ${args.join(" ")}`);
}

async function listWorkflows(): Promise<void> {
	const project = await loadPalantirProject(process.cwd());
	writeJson({ workflows: project.registry.list() });
}

async function startWorkflowRun(workflowId: string, args: readonly string[]): Promise<void> {
	const project = await loadPalantirProject(process.cwd());
	const workflow = project.registry.workflowById(workflowId);
	if (!workflow) throw new Error(`Unknown workflow: ${workflowId}`);
	const params = workflow.params.parse(parseJsonOption(args, "--params") ?? {});
	const configOverride = parseJsonOption(args, "--config");
	const id = randomUUID();
	const name = generateWorkflowRunName(new Set((await listWorkflowRuns(process.cwd())).map((run) => run.name)));
	const runRoot = resolve(process.cwd(), RUNS_ROOT, id);
	await mkdir(runRoot, { recursive: true });
	const createdAt = new Date().toISOString();
	await writeWorkflowLaunchRequest(runRoot, { version: 1, type: "run", id, name, workflowId, params, configOverride, createdAt });
	startDetachedExecuteRun(id);
	writeJson({ run: startedRunInfo({ id, name, workflow, runRoot, createdAt }) });
}

async function resumeWorkflowRun(run: string, args: readonly string[]): Promise<void> {
	const runRoot = await resolveWorkflowRunRoot(process.cwd(), run);
	const runInfo = await getWorkflowRunInfo(runRoot);
	const params = parseJsonOption(args, "--params");
	await writeWorkflowResumeRequest(runRoot, { version: 1, type: "resume", id: runInfo.id, params, createdAt: new Date().toISOString() });
	startDetachedExecuteRun(runInfo.id);
	writeJson({ run: { ...runInfo, status: "running", health: "healthy", updatedAt: new Date().toISOString() } });
}

async function executeWorkflowRun(runId: string): Promise<void> {
	const abortController = new AbortController();
	process.once("SIGTERM", () => abortController.abort(new Error("Stopped by user")));
	process.once("SIGINT", () => abortController.abort(new Error("Interrupted")));
	const runRoot = resolve(process.cwd(), RUNS_ROOT, runId);
	const project = await loadPalantirProject(process.cwd());
	const runtime = new PalantirRuntime({ cwd: process.cwd(), signal: abortController.signal, humanGateMode: "pause" });
	for (const plugin of project.plugins) runtime.registerPlugin(plugin);
	const launchRequest = await readOptionalWorkflowLaunchRequest(runRoot);
	if (launchRequest) {
		try {
			const workflow = project.registry.workflowById(launchRequest.workflowId);
			if (!workflow) throw new Error(`Unknown workflow: ${launchRequest.workflowId}`);
			await runtime.runWorkflow(workflow, launchRequest.params, { id: launchRequest.id, name: launchRequest.name, configOverride: launchRequest.configOverride });
			return;
		} finally {
			await rm(join(runRoot, "launch-request.json"), { force: true });
		}
	}
	const resumeRequest = await readWorkflowResumeRequest(runRoot);
	try {
		await runtime.resumeWorkflow(runRoot, resumeRequest.params);
	} finally {
		await rm(join(runRoot, "resume-request.json"), { force: true });
	}
}

async function rollbackWorkflowRun(run: string, args: readonly string[]): Promise<void> {
	const checkpointId = args[0];
	if (!checkpointId) throw new Error("Missing checkpoint id");
	const runRoot = await resolveWorkflowRunRoot(process.cwd(), run);
	const runtime = new PalantirRuntime({ cwd: process.cwd(), humanGateMode: "pause" });
	writeJson({ run: await runtime.rollbackRun(runRoot, checkpointId) });
}

async function inspectWorkflowRun(run: string): Promise<WorkflowRunInfo> {
	const runRoot = await resolveWorkflowRunRoot(process.cwd(), run);
	return getWorkflowRunInfo(runRoot);
}

async function inspectWorkflowRunHumanGate(run: string): Promise<void> {
	const runRoot = await resolveWorkflowRunRoot(process.cwd(), run);
	const project = await loadPalantirProject(process.cwd());
	const runtime = new PalantirRuntime({ cwd: process.cwd(), humanGateMode: "pause" });
	for (const plugin of project.plugins) runtime.registerPlugin(plugin);
	writeJson({ launch: await runtime.getActiveHumanGate(runRoot) });
}

async function signalWorkflowRun(run: string, signal: NodeJS.Signals): Promise<void> {
	const runRoot = await resolveWorkflowRunRoot(process.cwd(), run);
	await terminateWorkflowRun(runRoot, signal);
	writeJson({ run: await getWorkflowRunInfo(runRoot) });
}

async function deleteWorkflowRun(run: string): Promise<DeletedWorkflowRunInfo> {
	const runRoot = await resolveWorkflowRunRoot(process.cwd(), run);
	const runInfo = await getWorkflowRunInfo(runRoot);
	if (runInfo.status === "running") throw new Error(`Stop workflow run before deleting it: ${runInfo.name}`);
	await rm(runRoot, { recursive: true, force: true });
	return { id: runInfo.id, name: runInfo.name, path: runInfo.path };
}

async function terminateWorkflowRun(runRoot: string, signal: NodeJS.Signals): Promise<void> {
	const owner = await getWorkflowRunLeaseOwner(runRoot);
	if (!owner) return;
	sendSignal(owner.processGroupId, owner.pid, signal);
	await delay(signal === "SIGKILL" ? 250 : 1000);
}

async function writeWorkflowRunLogs(run: string, options: { readonly follow: boolean }): Promise<void> {
	const runRoot = await resolveWorkflowRunRoot(process.cwd(), run);
	let written = 0;
	while (true) {
		const events = await readWorkflowRunEvents(runRoot);
		for (const event of events.slice(written)) process.stdout.write(`${JSON.stringify(event)}\n`);
		written = events.length;
		if (!options.follow) return;
		const info = await getWorkflowRunInfo(runRoot);
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
	readonly workflow: AnyWorkflowDeclaration;
	readonly runRoot: string;
	readonly createdAt: string;
}): WorkflowRunInfo {
	return {
		version: 1,
		id: input.id,
		name: input.name,
		path: input.runRoot,
		rootWorkflowId: input.workflow.id,
		currentWorkflowId: input.workflow.id,
		status: "running",
		health: "healthy",
		startedAt: input.createdAt,
		updatedAt: input.createdAt,
	};
}

async function readOptionalWorkflowLaunchRequest(runRoot: string) {
	try {
		return await readWorkflowLaunchRequest(runRoot);
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function readWorkflowRunEvents(runRoot: string): Promise<readonly Record<string, unknown>[]> {
	try {
		const manifest = JSON.parse(await readFile(join(runRoot, "current", "manifest.json"), "utf8")) as { events?: readonly Record<string, unknown>[] };
		return manifest.events ?? [];
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return [];
		throw error;
	}
}

function parseJsonOption(args: readonly string[], name: string): unknown {
	const index = args.indexOf(name);
	if (index === -1) return undefined;
	const value = args[index + 1];
	if (!value) throw new Error(`Missing value for ${name}`);
	return JSON.parse(value);
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
