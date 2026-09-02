import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline";
import type {
	DeletedNornRunInfo,
	NornRegisteredWorkflowInfo,
	NornInspectedWorkflowInfo,
	NornProjectInfo,
	NornRunCheckpoint,
	NornRunInfo,
	NornRunMetrics,
	NornWorkflowStateReader,
} from "./api.ts";
import { loadNornProject } from "./plugin-loader.ts";
import type { NornRegisteredWorkflow } from "./internal/workflow-registry.ts";
import type { NornResolvedSeerModeConfig } from "./seer/index.ts";

export type NornClientInput = {
	readonly spawnCwd?: string;
	readonly executablePath?: string;
};

export type NornClient = {
	readonly project: {
		inspect(): Promise<NornProjectInfo>;
	};
	readonly workflows: {
		list(options?: { readonly all?: boolean }): Promise<NornRegisteredWorkflowInfo[]>;
		inspect(workflowId: string): Promise<NornInspectedWorkflowInfo>;
		entries(): Promise<readonly NornRegisteredWorkflow[]>;
	};
	readonly state: NornWorkflowStateReader;
	readonly seer: {
		inspect(): Promise<NornResolvedSeerModeConfig | null>;
	};
	readonly runs: {
		start(input: { readonly workflowId: string; readonly params: unknown; readonly configOverride?: unknown }): Promise<NornRunInfo>;
		resume(input: { readonly run: string; readonly params?: unknown }): Promise<NornRunInfo>;
		wait(run: string): Promise<NornRunInfo>;
		list(): Promise<NornRunInfo[]>;
		inspect(run: string): Promise<NornRunInfo>;
		checkpoints(run: string): Promise<NornRunCheckpoint[]>;
		metrics(run: string): Promise<NornRunMetrics>;
		rollback(run: string, checkpointId: string): Promise<NornRunInfo>;
		stop(run: string): Promise<NornRunInfo>;
		kill(run: string): Promise<NornRunInfo>;
		delete(run: string): Promise<DeletedNornRunInfo>;
		logs(run: string, options?: { readonly follow?: boolean }): AsyncIterable<Record<string, unknown>>;
	};
};

export function createNornClient(input: NornClientInput = {}): NornClient {
	const processRunner = new NornProcessRunner(input);
	const catalog = new NornWorkflowCatalog(input.spawnCwd ?? process.cwd());
	const client: NornClient = {
		project: {
			inspect: async () => (await processRunner.readJson<{ project: NornProjectInfo }>(["project", "inspect"])).project,
		},
		workflows: {
			list: async (options) => (await processRunner.readJson<{ workflows: NornRegisteredWorkflowInfo[] }>(["workflows", "list", ...(options?.all ? ["--all"] : [])])).workflows,
			inspect: async (workflowId) => (await processRunner.readJson<{ workflow: NornInspectedWorkflowInfo }>(["workflows", "inspect", workflowId])).workflow,
			entries: async () => (await catalog.load()).workflows,
		},
		state: catalog.state,
		seer: {
			inspect: async () => (await processRunner.readJson<{ seerMode: NornResolvedSeerModeConfig | null }>(["seer", "inspect"])).seerMode,
		},
		runs: {
			start: async (startInput) => (await processRunner.readJson<{ run: NornRunInfo }>(["runs", "start", startInput.workflowId], JSON.stringify(runStartInput(startInput)))).run,
			resume: async (resumeInput) => (await processRunner.readJson<{ run: NornRunInfo }>(["runs", "resume", resumeInput.run], runResumeStdin(resumeInput))).run,
			wait: async (run) => (await processRunner.readJson<{ run: NornRunInfo }>(["runs", "wait", run])).run,
			list: async () => (await processRunner.readJson<{ runs: NornRunInfo[] }>(["runs", "list"])).runs,
			inspect: async (run) => (await processRunner.readJson<{ run: NornRunInfo }>(["runs", "inspect", run])).run,
			checkpoints: async (run) => (await processRunner.readJson<{ checkpoints: NornRunCheckpoint[] }>(["runs", "checkpoints", run])).checkpoints,
			metrics: async (run) => (await processRunner.readJson<{ metrics: NornRunMetrics }>(["runs", "metrics", run])).metrics,
			rollback: async (run, checkpointId) => (await processRunner.readJson<{ run: NornRunInfo }>(["runs", "rollback", run, checkpointId])).run,
			stop: async (run) => (await processRunner.readJson<{ run: NornRunInfo }>(["runs", "stop", run])).run,
			kill: async (run) => (await processRunner.readJson<{ run: NornRunInfo }>(["runs", "kill", run])).run,
			delete: async (run) => (await processRunner.readJson<{ deleted: DeletedNornRunInfo }>(["runs", "delete", run])).deleted,
			logs: (run, options) => processRunner.readJsonLines(["runs", "logs", run, ...(options?.follow ? ["--follow"] : [])]),
		},
	};
	return client;
}

class NornWorkflowCatalog {
	private loaded: ReturnType<typeof loadNornProject> | undefined;
	readonly state: NornWorkflowStateReader = {
		get: async (state) => (await this.load()).state.get(state),
		getOptional: async (state) => (await this.load()).state.getOptional(state),
	};

	constructor(private readonly cwd: string) {}

	load(): ReturnType<typeof loadNornProject> {
		this.loaded ??= loadNornProject(this.cwd);
		return this.loaded;
	}
}

class NornProcessRunner {
	private readonly executablePath: string;

	constructor(private readonly input: NornClientInput) {
		this.executablePath = input.executablePath ?? fileURLToPath(new URL("../bin/norn.mjs", import.meta.url));
	}

	async readJson<T>(args: readonly string[], stdin?: string): Promise<T> {
		const result = await this.spawn(args, stdin);
		const parsed = JSON.parse(result.stdout) as T | { error?: { message?: string } };
		if (parsed && typeof parsed === "object" && "error" in parsed) throw new Error(parsed.error?.message ?? "Norn command failed");
		if (result.exitCode !== 0) throw new Error(result.stderr || `Norn exited with code ${result.exitCode}`);
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
			if (parsed.error) throw new Error(String((parsed.error as { message?: unknown }).message ?? "Norn stream failed"));
			yield parsed;
		}
		const exitCode = await new Promise<number | null>((resolvePromise) => child.on("close", resolvePromise));
		if (exitCode !== 0) throw new Error(stderr || `Norn exited with code ${exitCode}`);
	}

	private async spawn(args: readonly string[], stdin?: string): Promise<{ readonly stdout: string; readonly stderr: string; readonly exitCode: number | null }> {
		return new Promise((resolvePromise, reject) => {
			const child = spawn(process.execPath, [this.executablePath, ...args], { cwd: this.input.spawnCwd, stdio: [stdin === undefined ? "ignore" : "pipe", "pipe", "pipe"] });
			let stdout = "";
			let stderr = "";
			child.stdout?.on("data", (chunk) => {
				stdout += chunk.toString();
			});
			child.stderr?.on("data", (chunk) => {
				stderr += chunk.toString();
			});
			child.on("error", reject);
			if (stdin !== undefined) child.stdin?.end(stdin);
			child.on("close", (exitCode) => resolvePromise({ stdout, stderr, exitCode }));
		});
	}
}

function runStartInput(input: { readonly params: unknown; readonly configOverride?: unknown }): { readonly params: unknown; readonly config?: unknown } {
	return input.configOverride === undefined ? { params: input.params } : { params: input.params, config: input.configOverride };
}

function runResumeStdin(input: { readonly params?: unknown }): string | undefined {
	return input.params === undefined ? undefined : JSON.stringify({ params: input.params });
}
