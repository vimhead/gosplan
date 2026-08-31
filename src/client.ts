import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type {
	DeletedPalantirRunInfo,
	PalantirRegisteredWorkflowInfo,
	PalantirInterruptedRunResult,
	PalantirRunCheckpoint,
	PalantirRunInfo,
	PalantirRunMetrics,
	PalantirWorkflowStateReader,
} from "./api.ts";
import { loadPalantirProject } from "./plugin-loader.ts";
import type { PalantirRegisteredWorkflow } from "./internal/workflow-registry.ts";
import type { PalantirResolvedSeerModeConfig } from "./seer/index.ts";

export type PalantirClientInput = {
	readonly spawnCwd?: string;
	readonly executablePath?: string;
};

export type PalantirClient = {
	readonly workflows: {
		list(): Promise<PalantirRegisteredWorkflowInfo[]>;
		entries(): Promise<readonly PalantirRegisteredWorkflow[]>;
	};
	readonly state: PalantirWorkflowStateReader;
	readonly seer: {
		inspect(): Promise<PalantirResolvedSeerModeConfig | null>;
	};
	readonly runs: {
		start(input: { readonly workflowId: string; readonly params: unknown; readonly configOverride?: unknown }): Promise<PalantirRunInfo>;
		resume(input: { readonly run: string; readonly params?: unknown }): Promise<PalantirRunInfo>;
		wait(run: string): Promise<PalantirRunInfo>;
		list(): Promise<PalantirRunInfo[]>;
		inspect(run: string): Promise<PalantirRunInfo>;
		checkpoints(run: string): Promise<PalantirRunCheckpoint[]>;
		metrics(run: string): Promise<PalantirRunMetrics>;
		gate(run: string): Promise<PalantirInterruptedRunResult>;
		rollback(run: string, checkpointId: string): Promise<PalantirRunInfo>;
		stop(run: string): Promise<PalantirRunInfo>;
		kill(run: string): Promise<PalantirRunInfo>;
		delete(run: string): Promise<DeletedPalantirRunInfo>;
		logs(run: string, options?: { readonly follow?: boolean }): AsyncIterable<Record<string, unknown>>;
	};
};

export function createPalantirClient(input: PalantirClientInput = {}): PalantirClient {
	const processRunner = new PalantirProcessRunner(input);
	const catalog = new PalantirWorkflowCatalog(input.spawnCwd ?? process.cwd());
	const client: PalantirClient = {
		workflows: {
			list: async () => (await processRunner.readJson<{ workflows: PalantirRegisteredWorkflowInfo[] }>(["workflows", "list"])).workflows,
			entries: async () => (await catalog.load()).workflows,
		},
		state: catalog.state,
		seer: {
			inspect: async () => (await processRunner.readJson<{ seerMode: PalantirResolvedSeerModeConfig | null }>(["seer", "inspect"])).seerMode,
		},
		runs: {
			start: async (startInput) => (await processRunner.readJson<{ run: PalantirRunInfo }>(["runs", "start", startInput.workflowId, "--params", JSON.stringify(startInput.params), ...configArgs(startInput.configOverride)])).run,
			resume: async (resumeInput) => (await processRunner.readJson<{ run: PalantirRunInfo }>(["runs", "resume", resumeInput.run, ...paramsArgs(resumeInput.params)])).run,
			wait: async (run) => (await processRunner.readJson<{ run: PalantirRunInfo }>(["runs", "wait", run])).run,
			list: async () => (await processRunner.readJson<{ runs: PalantirRunInfo[] }>(["runs", "list"])).runs,
			inspect: async (run) => (await processRunner.readJson<{ run: PalantirRunInfo }>(["runs", "inspect", run])).run,
			checkpoints: async (run) => (await processRunner.readJson<{ checkpoints: PalantirRunCheckpoint[] }>(["runs", "checkpoints", run])).checkpoints,
			metrics: async (run) => (await processRunner.readJson<{ metrics: PalantirRunMetrics }>(["runs", "metrics", run])).metrics,
			gate: async (run) => (await processRunner.readJson<{ launch: PalantirInterruptedRunResult }>(["runs", "gate", run])).launch,
			rollback: async (run, checkpointId) => (await processRunner.readJson<{ run: PalantirRunInfo }>(["runs", "rollback", run, checkpointId])).run,
			stop: async (run) => (await processRunner.readJson<{ run: PalantirRunInfo }>(["runs", "stop", run])).run,
			kill: async (run) => (await processRunner.readJson<{ run: PalantirRunInfo }>(["runs", "kill", run])).run,
			delete: async (run) => (await processRunner.readJson<{ deleted: DeletedPalantirRunInfo }>(["runs", "delete", run])).deleted,
			logs: (run, options) => processRunner.readJsonLines(["runs", "logs", run, ...(options?.follow ? ["--follow"] : [])]),
		},
	};
	return client;
}

class PalantirWorkflowCatalog {
	private loaded: ReturnType<typeof loadPalantirProject> | undefined;
	readonly state: PalantirWorkflowStateReader = {
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
