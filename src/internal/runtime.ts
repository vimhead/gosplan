import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { AnyWorkflowDeclaration, WorkflowCallOptions, WorkflowOutcomeMetadata, WorkflowParamsInput, WorkflowRuntime } from "../api.ts";
import type { AgentResponseCollector } from "./agent-response-tool.ts";
import type { WorkflowArtifacts } from "./artifacts.ts";
import { WorkflowAgentRunner } from "./agents.ts";
import { WorkflowCommandRunner } from "./commands.ts";
import type { WorkflowRunLogs } from "./logs.ts";
import type { WorkflowRunLogger } from "./run-log.ts";
import type { JsonWorkflowState } from "./state-store.ts";

type DefaultWorkflowRuntimeInput = {
	readonly id: string;
	readonly runRoot: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly signal?: AbortSignal;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly agentDir?: string;
	readonly responseCollector: AgentResponseCollector;
	readonly state: JsonWorkflowState;
	readonly logger: WorkflowRunLogger;
	readonly artifacts: WorkflowArtifacts;
	readonly logs: WorkflowRunLogs;
};

export class DefaultWorkflowRuntime implements WorkflowRuntime {
	readonly state: WorkflowRuntime["state"];
	readonly artifacts: WorkflowRuntime["artifacts"];
	readonly logs: WorkflowRuntime["logs"];
	readonly commands: WorkflowRuntime["commands"];
	readonly agents: WorkflowRuntime["agents"];
	readonly id: string;
	readonly workspace: string;
	readonly cwd: string;

	constructor(private readonly input: DefaultWorkflowRuntimeInput) {
		this.id = input.id;
		this.workspace = input.workspace;
		this.cwd = input.cwd;
		this.state = input.state;
		this.artifacts = input.artifacts;
		this.logs = {
			read: (log) => this.input.logs.read(log),
		};
		this.commands = {
			run: (commandInput) =>
				new WorkflowCommandRunner({
					workspace: this.workspace,
					cwd: this.cwd,
					env: this.input.env,
					signal: this.input.signal,
					logs: this.input.logs,
					logger: this.input.logger,
				}).run(commandInput),
		};
		this.agents = {
			spawn: (agentInput) => this.createAgentRunner().spawn(agentInput),
			run: (agentInput) => this.createAgentRunner().run(agentInput),
		};
	}

	private createAgentRunner(): WorkflowAgentRunner {
		return new WorkflowAgentRunner({
			id: this.id,
			runRoot: this.input.runRoot,
			workspace: this.workspace,
			cwd: this.cwd,
			signal: this.input.signal,
			model: this.input.model,
			thinkingLevel: this.input.thinkingLevel,
			agentDir: this.input.agentDir,
			logs: this.input.logs,
			logger: this.input.logger,
			responseCollector: this.input.responseCollector,
		});
	}

	with(options: { cwd?: string; env?: Record<string, string> }): WorkflowRuntime {
		return new DefaultWorkflowRuntime({
			...this.input,
			cwd: options.cwd ? this.resolveFromCwd(options.cwd) : this.cwd,
			env: { ...this.input.env, ...(options.env ?? {}) },
		});
	}

	path(relativePath: string): string {
		return this.resolveFromCwd(relativePath);
	}

	next<TWorkflow extends AnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: WorkflowParamsInput<TWorkflow>,
		options?: WorkflowCallOptions<TWorkflow>,
	): ReturnType<WorkflowRuntime["next"]>;
	next(workflowId: string, params: unknown, options?: { readonly configOverride?: unknown }): ReturnType<WorkflowRuntime["next"]>;
	next(
		workflow: AnyWorkflowDeclaration | string,
		params: unknown,
		options?: { readonly configOverride?: unknown },
	): ReturnType<WorkflowRuntime["next"]> {
		return {
			type: "next",
			workflowId: typeof workflow === "string" ? workflow : workflow.id,
			params,
			configOverride: options?.configOverride,
			cwd: this.cwd,
			env: this.input.env,
		};
	}

	complete(metadata?: WorkflowOutcomeMetadata): ReturnType<WorkflowRuntime["complete"]> {
		return { type: "complete", metadata };
	}

	fail(metadata: WorkflowOutcomeMetadata & { readonly summary: string }): ReturnType<WorkflowRuntime["fail"]> {
		return { type: "fail", metadata };
	}

	private resolveFromCwd(path: string): string {
		const resolvedPath = isAbsolute(path) ? path : resolve(this.cwd, path);
		const pathFromWorkspace = relative(this.workspace, resolvedPath);
		if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
			throw new Error(`Workflow path escapes workspace: ${path}`);
		}
		return resolvedPath;
	}
}
