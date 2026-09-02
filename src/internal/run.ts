import { isAbsolute, relative, resolve, sep } from "node:path";
import type { CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";
import type { PalantirAnyWorkflowDeclaration, PalantirProjectRun, PalantirRunOutcomeMetadata, PalantirWorkflowIsolationMode, PalantirWorkflowParamsInput, PalantirRun } from "../api.ts";
import type { PalantirAgentResponseCollector } from "./agent-response-tool.ts";
import type { PalantirArtifacts } from "./artifacts.ts";
import { PalantirAgentRunner } from "./agents.ts";
import { PalantirCommandRunner } from "./commands.ts";
import type { PalantirRunLogs } from "./logs.ts";
import type { PalantirRunLogger } from "./run-log.ts";
import type { PalantirJsonWorkflowState } from "./state-store.ts";

type DefaultPalantirRunInput = {
	readonly id: string;
	readonly runRoot: string;
	readonly projectRoot: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly isolationMode: PalantirWorkflowIsolationMode;
	readonly signal?: AbortSignal;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly agentDir?: string;
	readonly responseCollector: PalantirAgentResponseCollector;
	readonly state: PalantirJsonWorkflowState;
	readonly logger: PalantirRunLogger;
	readonly artifacts: PalantirArtifacts;
	readonly logs: PalantirRunLogs;
};

export class PalantirRunContext implements PalantirProjectRun {
	readonly state: PalantirRun["state"];
	readonly artifacts: PalantirRun["artifacts"];
	readonly logs: PalantirRun["logs"];
	readonly commands: PalantirRun["commands"];
	readonly agents: PalantirRun["agents"];
	readonly id: string;
	readonly workspace: string;
	readonly projectRoot: string;
	readonly cwd: string;

	constructor(private readonly input: DefaultPalantirRunInput) {
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
				new PalantirCommandRunner({
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

	forWorkflow(workflow: PalantirAnyWorkflowDeclaration): PalantirRunContext {
		const isolationMode = workflow.isolation.mode;
		return new PalantirRunContext({
			...this.input,
			isolationMode,
			cwd: isolationMode === "project" ? this.projectRoot : this.workspace,
		});
	}

	private get boundaryRoot(): string {
		return this.input.isolationMode === "project" ? this.projectRoot : this.workspace;
	}

	private createAgentRunner(): PalantirAgentRunner {
		return new PalantirAgentRunner({
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

	next<TWorkflow extends PalantirAnyWorkflowDeclaration>(
		workflow: TWorkflow,
		params: PalantirWorkflowParamsInput<TWorkflow>,
	): ReturnType<PalantirRun["next"]>;
	next(workflowId: string, params: unknown): ReturnType<PalantirRun["next"]>;
	next(workflow: PalantirAnyWorkflowDeclaration | string, params: unknown): ReturnType<PalantirRun["next"]> {
		return {
			type: "next",
			workflowId: typeof workflow === "string" ? workflow : workflow.id,
			params,
		};
	}

	complete(metadata?: PalantirRunOutcomeMetadata): ReturnType<PalantirRun["complete"]> {
		return { type: "complete", metadata };
	}

	fail(metadata: PalantirRunOutcomeMetadata & { readonly summary: string }): ReturnType<PalantirRun["fail"]> {
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
