import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { z } from "zod";
import type { NornAnyWorkflowDeclaration, NornProjectRun, NornRunOutcomeMetadata, NornWorkflowIsolationMode, NornWorkflowTarget, NornRun } from "../api.ts";
import type { NornAgentResponseCollector } from "./agent-response-tool.ts";
import type { NornArtifacts } from "./artifacts.ts";
import { NornAgentRunner } from "./agents.ts";
import { NornCommandRunner } from "./commands.ts";
import type { NornRunLogs } from "./logs.ts";
import type { NornRunLogger } from "./run-log.ts";
import type { NornJsonWorkflowState } from "./state-store.ts";

type DefaultNornRunInput = {
	readonly id: string;
	readonly runRoot: string;
	readonly projectRoot: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly isolationMode: NornWorkflowIsolationMode;
	readonly signal?: AbortSignal;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly agentDir?: string;
	readonly responseCollector: NornAgentResponseCollector;
	readonly state: NornJsonWorkflowState;
	readonly logger: NornRunLogger;
	readonly artifacts: NornArtifacts;
	readonly logs: NornRunLogs;
};

export class NornRunContext implements NornProjectRun {
	readonly state: NornRun["state"];
	readonly artifacts: NornRun["artifacts"];
	readonly logs: NornRun["logs"];
	readonly commands: NornRun["commands"];
	readonly agents: NornRun["agents"];
	readonly id: string;
	readonly workspace: string;
	readonly projectRoot: string;
	readonly cwd: string;

	constructor(private readonly input: DefaultNornRunInput) {
		this.id = input.id;
		this.workspace = input.workspace;
		this.projectRoot = input.projectRoot;
		this.cwd = input.cwd;
		this.state = input.state;
		this.artifacts = input.artifacts;
		this.logs = {
			read: (log) => this.input.logs.read(log),
		};
		this.commands = {
			run: (commandInput) =>
				new NornCommandRunner({
					boundaryRoot: this.boundaryRoot,
					boundaryName: this.input.isolationMode,
					cwd: this.cwd,
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

	forWorkflow(workflow: NornAnyWorkflowDeclaration): NornRunContext {
		const isolationMode = workflow.isolation.mode;
		return new NornRunContext({
			...this.input,
			isolationMode,
			cwd: isolationMode === "project" ? this.projectRoot : this.workspace,
		});
	}

	private get boundaryRoot(): string {
		return this.input.isolationMode === "project" ? this.projectRoot : this.workspace;
	}

	private createAgentRunner(): NornAgentRunner {
		return new NornAgentRunner({
			id: this.id,
			runRoot: this.input.runRoot,
			boundaryRoot: this.boundaryRoot,
			boundaryName: this.input.isolationMode,
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

	path(relativePath: string): string {
		return this.resolveFromRoot(this.cwd, this.boundaryRoot, relativePath);
	}

	projectPath(relativePath: string): string {
		return this.resolveFromRoot(this.projectRoot, this.projectRoot, relativePath);
	}

	next<ParamsSchema extends z.ZodType>(workflow: NornWorkflowTarget<ParamsSchema>, params: z.input<ParamsSchema>): ReturnType<NornRun["next"]> {
		return {
			type: "next",
			workflowId: typeof workflow === "string" ? workflow : workflow.id,
			params,
		};
	}

	complete(metadata?: NornRunOutcomeMetadata): ReturnType<NornRun["complete"]> {
		return { type: "complete", metadata };
	}

	fail(metadata: NornRunOutcomeMetadata & { readonly summary: string }): ReturnType<NornRun["fail"]> {
		return { type: "fail", metadata };
	}

	private resolveFromRoot(root: string, boundaryRoot: string, path: string): string {
		const resolvedPath = isAbsolute(path) ? path : resolve(root, path);
		const pathFromBoundary = relative(boundaryRoot, resolvedPath);
		if (pathFromBoundary === ".." || pathFromBoundary.startsWith(`..${sep}`) || isAbsolute(pathFromBoundary)) {
			throw new Error(`Workflow path escapes ${this.input.isolationMode} isolation: ${path}`);
		}
		return resolvedPath;
	}
}
