import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type {
	DeletedWorkflowRunInfo,
	RegisteredWorkflowInfo,
	WorkflowInterruptedLaunchResult,
	WorkflowRunCheckpoint,
	WorkflowRunInfo,
	WorkflowStateReader,
} from "./api.ts";
import { loadPalantirProject } from "./plugin-loader.ts";
import type { RegisteredWorkflow } from "./internal/workflow-registry.ts";

export type PalantirClientInput = {
	readonly spawnCwd?: string;
	readonly executablePath?: string;
};

export type PalantirClient = {
	readonly workflows: {
		list(): Promise<RegisteredWorkflowInfo[]>;
		entries(): Promise<readonly RegisteredWorkflow[]>;
	};
	readonly state: WorkflowStateReader;
	readonly runs: {
		start(input: { readonly workflowId: string; readonly params: unknown; readonly configOverride?: unknown }): Promise<WorkflowRunInfo>;
		resume(input: { readonly run: string; readonly params?: unknown }): Promise<WorkflowRunInfo>;
		list(): Promise<WorkflowRunInfo[]>;
		inspect(run: string): Promise<WorkflowRunInfo>;
		checkpoints(run: string): Promise<WorkflowRunCheckpoint[]>;
		humanGate(run: string): Promise<WorkflowInterruptedLaunchResult>;
		rollback(run: string, checkpointId: string): Promise<WorkflowRunInfo>;
		stop(run: string): Promise<WorkflowRunInfo>;
		kill(run: string): Promise<WorkflowRunInfo>;
		delete(run: string): Promise<DeletedWorkflowRunInfo>;
		logs(run: string, options?: { readonly follow?: boolean }): AsyncIterable<Record<string, unknown>>;
	};
};

export function createPalantirClient(input: PalantirClientInput = {}): PalantirClient {
	const processRunner = new PalantirProcessRunner(input);
	const catalog = new PalantirWorkflowCatalog(input.spawnCwd ?? process.cwd());
	const client: PalantirClient = {
		workflows: {
			list: async () => (await processRunner.readJson<{ workflows: RegisteredWorkflowInfo[] }>(["workflows", "list"])).workflows,
			entries: async () => (await catalog.load()).workflows,
		},
		state: catalog.state,
		runs: {
			start: async (startInput) => (await processRunner.readJson<{ run: WorkflowRunInfo }>(["runs", "start", startInput.workflowId, "--params", JSON.stringify(startInput.params), ...configArgs(startInput.configOverride)])).run,
			resume: async (resumeInput) => (await processRunner.readJson<{ run: WorkflowRunInfo }>(["runs", "resume", resumeInput.run, ...paramsArgs(resumeInput.params)])).run,
			list: async () => (await processRunner.readJson<{ runs: WorkflowRunInfo[] }>(["runs", "list"])).runs,
			inspect: async (run) => (await processRunner.readJson<{ run: WorkflowRunInfo }>(["runs", "inspect", run])).run,
			checkpoints: async (run) => (await processRunner.readJson<{ checkpoints: WorkflowRunCheckpoint[] }>(["runs", "checkpoints", run])).checkpoints,
			humanGate: async (run) => (await processRunner.readJson<{ launch: WorkflowInterruptedLaunchResult }>(["runs", "human-gate", run])).launch,
			rollback: async (run, checkpointId) => (await processRunner.readJson<{ run: WorkflowRunInfo }>(["runs", "rollback", run, checkpointId])).run,
			stop: async (run) => (await processRunner.readJson<{ run: WorkflowRunInfo }>(["runs", "stop", run])).run,
			kill: async (run) => (await processRunner.readJson<{ run: WorkflowRunInfo }>(["runs", "kill", run])).run,
			delete: async (run) => (await processRunner.readJson<{ deleted: DeletedWorkflowRunInfo }>(["runs", "delete", run])).deleted,
			logs: (run, options) => processRunner.readJsonLines(["runs", "logs", run, ...(options?.follow ? ["--follow"] : [])]),
		},
	};
	return client;
}

class PalantirWorkflowCatalog {
	private loaded: ReturnType<typeof loadPalantirProject> | undefined;
	readonly state: WorkflowStateReader = {
		get: async (state) => (await this.load()).state.get(state),
		getOptional: async (state) => (await this.load()).state.getOptional(state),
	};

	constructor(private readonly cwd: string) {}

	load(): ReturnType<typeof loadPalantirProject> {
		this.loaded ??= loadPalantirProject(this.cwd);
		return this.loaded;
	}
}

class PalantirProcessRunner {
	private readonly executablePath: string;

	constructor(private readonly input: PalantirClientInput) {
		this.executablePath = input.executablePath ?? fileURLToPath(new URL("../bin/palantir.mjs", import.meta.url));
	}

	async readJson<T>(args: readonly string[]): Promise<T> {
		const result = await this.spawn(args);
		const parsed = JSON.parse(result.stdout) as T | { error?: { message?: string } };
		if (parsed && typeof parsed === "object" && "error" in parsed) throw new Error(parsed.error?.message ?? "Palantir command failed");
		if (result.exitCode !== 0) throw new Error(result.stderr || `Palantir exited with code ${result.exitCode}`);
		return parsed as T;
	}

	async *readJsonLines(args: readonly string[]): AsyncIterable<Record<string, unknown>> {
		const child = spawn(process.execPath, [this.executablePath, ...args], { cwd: this.input.spawnCwd, stdio: ["ignore", "pipe", "pipe"] });
		let stderr = "";
		child.stderr?.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		const lines = createInterface({ input: child.stdout });
		for await (const line of lines) {
			if (line.trim().length === 0) continue;
			const parsed = JSON.parse(line) as Record<string, unknown>;
			if (parsed.error) throw new Error(String((parsed.error as { message?: unknown }).message ?? "Palantir stream failed"));
			yield parsed;
		}
		const exitCode = await new Promise<number | null>((resolvePromise) => child.on("close", resolvePromise));
		if (exitCode !== 0) throw new Error(stderr || `Palantir exited with code ${exitCode}`);
	}

	private async spawn(args: readonly string[]): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> {
		return new Promise((resolvePromise, reject) => {
			const child = spawn(process.execPath, [this.executablePath, ...args], { cwd: this.input.spawnCwd, stdio: ["ignore", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			child.on("close", (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
		});
	}
}

function paramsArgs(params: unknown): string[] {
	return params === undefined ? [] : ["--params", JSON.stringify(params)];
}

function configArgs(configOverride: unknown): string[] {
	return configOverride === undefined ? [] : ["--config", JSON.stringify(configOverride)];
}
