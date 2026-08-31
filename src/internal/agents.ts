import {
	DefaultResourceLoader,
	SessionManager,
	createAgentSession,
	createEventBus,
	getAgentDir,
	type AgentSession,
	type CreateAgentSessionOptions,
} from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { z } from "zod";
import type { AgentPromptInput, AgentRunInput, AgentRunRawAttempt, AgentRunResult, AgentSessionEvents, AgentSpawnInput, WorkflowAgentSession, WorkflowUsage } from "../api.ts";
import {
	AGENT_RESPONSE_TOOL_NAME,
	AgentResponseCollector,
	AgentResponseToolFactory,
	type CapturedAgentResponse,
} from "./agent-response-tool.ts";
import { errorMessage } from "./errors.ts";
import type { WorkflowRunLogs } from "./logs.ts";
import { safeFileName } from "./file-names.ts";
import type { WorkflowRunLogger } from "./run-log.ts";
import { emptyWorkflowUsage, totalWorkflowUsage, workflowUsageFromValue } from "./usage.ts";

const DEFAULT_AGENT_ATTEMPTS = 3;
const DEFAULT_AGENT_TOOL_ALLOWLIST = ["read", "bash", "edit", "write", AGENT_RESPONSE_TOOL_NAME] as const;

type WorkflowAgentRunnerInput = {
	readonly id: string;
	readonly runRoot: string;
	readonly workspace: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly agentDir?: string;
	readonly logs: WorkflowRunLogs;
	readonly logger: WorkflowRunLogger;
	readonly responseCollector: AgentResponseCollector;
};

type SpawnedWorkflowAgentSessionInput = WorkflowAgentRunnerInput & {
	readonly label: string;
	readonly cwd: string;
	readonly session: AgentSession;
	readonly events: AgentSessionEvents;
};

export class WorkflowAgentRunner {
	private readonly responseToolFactory: AgentResponseToolFactory;

	constructor(private readonly input: WorkflowAgentRunnerInput) {
		this.responseToolFactory = new AgentResponseToolFactory(input.responseCollector);
	}

	async spawn(agentInput: AgentSpawnInput): Promise<WorkflowAgentSession> {
		const cwd = agentInput.cwd ? this.resolveFromCwd(agentInput.cwd) : this.input.cwd;
		const sessionDir = resolve(this.input.runRoot, "sessions");
		await mkdir(sessionDir, { recursive: true });

		const eventBus = createEventBus();
		const agentDir = this.input.agentDir ?? getAgentDir();
		const loader = new DefaultResourceLoader({ cwd, agentDir, eventBus });
		await loader.reload();
		const { session } = await createAgentSession({
			cwd,
			resourceLoader: loader,
			sessionManager: SessionManager.create(cwd, sessionDir),
			tools: withAgentResponseTool(agentInput.tools),
			customTools: [this.responseToolFactory.create()],
			model: agentInput.model ?? this.input.model,
			thinkingLevel: agentInput.thinkingLevel ?? this.input.thinkingLevel,
		});

		await this.input.logger.record({ type: "agent.spawned", label: agentInput.label, cwd });
		return new SpawnedWorkflowAgentSession({
			...this.input,
			label: agentInput.label,
			cwd,
			session,
			events: eventBus,
		});
	}

	async run<ResponseSchema extends z.ZodType>(agentInput: AgentRunInput<ResponseSchema>): Promise<AgentRunResult<ResponseSchema>> {
		const agent = await this.spawn(agentInput);
		try {
			return await agent.run(agentInput);
		} finally {
			await agent.dispose();
		}
	}

	private resolveFromCwd(path: string): string {
		const resolvedPath = isAbsolute(path) ? path : resolve(this.input.cwd, path);
		const pathFromWorkspace = relative(this.input.workspace, resolvedPath);
		if (pathFromWorkspace === ".." || pathFromWorkspace.startsWith(`..${sep}`) || isAbsolute(pathFromWorkspace)) {
			throw new Error(`Agent cwd escapes workflow workspace: ${path}`);
		}
		return resolvedPath;
	}
}

class SpawnedWorkflowAgentSession implements WorkflowAgentSession {
	readonly label: string;
	readonly cwd: string;
	readonly events: AgentSessionEvents;
	private isDisposed = false;

	constructor(private readonly input: SpawnedWorkflowAgentSessionInput) {
		this.label = input.label;
		this.cwd = input.cwd;
		this.events = input.events;
	}

	async run<ResponseSchema extends z.ZodType>(agentInput: AgentPromptInput<ResponseSchema>): Promise<AgentRunResult<ResponseSchema>> {
		if (this.isDisposed) throw new Error(`Workflow agent session is disposed: ${this.label}`);
		const maxAttempts = Math.max(1, Math.floor(agentInput.maxAttempts ?? DEFAULT_AGENT_ATTEMPTS));
		const attempts: AgentRunRawAttempt[] = [];
		const startedAtMs = Date.now();
		let isTerminalEventRecorded = false;
		await this.input.logger.record({ type: "agent.started", label: this.label, cwd: this.cwd, maxAttempts });

		try {
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				await this.input.logger.record({ type: "agent.attempt.started", label: this.label, attempt });
				const raw = await this.runAttempt(agentInput, attempt, attempts.at(-1)?.error);
				const rawAttempt: AgentRunRawAttempt = { attempt, ...raw };
				attempts.push(rawAttempt);

				try {
					if (!raw.responseToolCalled) throw new Error(`Agent did not call ${AGENT_RESPONSE_TOOL_NAME}`);
					const response = agentInput.response.parse(raw.toolResponse);
					const usage = totalWorkflowUsage(attempts.map((candidate) => candidate.usage));
					const result: AgentRunResult<ResponseSchema> = {
						label: this.label,
						cwd: this.cwd,
						response,
						usage,
						raw: { ...raw, usage, attempts },
					};
					await this.input.logs.write(`agents/${safeFileName(this.label)}.json`, JSON.stringify(result, null, 2));
					isTerminalEventRecorded = true;
					await this.input.logger.record({ type: "agent.completed", label: this.label, attempts: attempt, durationMs: Date.now() - startedAtMs, usage });
					return result;
				} catch (error) {
					const message = errorMessage(error);
					attempts[attempts.length - 1] = { ...rawAttempt, error: message };
					await this.input.logs.write(
						`agents/${safeFileName(this.label)}.attempt-${attempt}.raw.json`,
						JSON.stringify({ label: this.label, cwd: this.cwd, raw: attempts.at(-1) }, null, 2),
					);
					await this.input.logger.record({ type: "agent.attempt.failed", label: this.label, attempt, error: message });
					if (attempt === maxAttempts) {
						const usage = totalWorkflowUsage(attempts.map((candidate) => candidate.usage));
						isTerminalEventRecorded = true;
						await this.input.logger.record({ type: "agent.failed", label: this.label, attempts: attempt, durationMs: Date.now() - startedAtMs, usage, error: message });
						throw new Error(
							`Agent ${this.label} did not return a valid structured response after ${attempt} attempt(s). Raw output saved to logs/agents/${safeFileName(this.label)}.attempt-${attempt}.raw.json: ${message}`,
						);
					}
				}
			}

			throw new Error(`Agent ${this.label} did not run`);
		} catch (error) {
			if (!isTerminalEventRecorded) {
				await this.input.logger.record({
					type: "agent.failed",
					label: this.label,
					attempts: attempts.length,
					durationMs: Date.now() - startedAtMs,
					usage: totalWorkflowUsage(attempts.map((candidate) => candidate.usage)),
					error: errorMessage(error),
				});
			}
			throw error;
		}
	}

	async dispose(): Promise<void> {
		if (this.isDisposed) return;
		this.isDisposed = true;
		this.input.session.dispose();
		await this.input.logger.record({ type: "agent.disposed", label: this.label });
	}

	private async runAttempt<ResponseSchema extends z.ZodType>(
		agentInput: AgentPromptInput<ResponseSchema>,
		attempt: number,
		previousError: string | undefined,
	): Promise<Omit<AgentRunRawAttempt, "attempt" | "error">> {
		const responseRunId = `${this.input.id}:${attempt}:${randomUUID()}`;
		const messages: unknown[] = [];
		let text = "";
		const releaseResponseSlot = this.input.responseCollector.begin(responseRunId, this.label, agentInput.response);
		const unsubscribe = this.input.session.subscribe((event) => {
			if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
				text += event.assistantMessageEvent.delta;
			}
			if (event.type === "message_end" && event.message) messages.push(event.message);
		});
		const abortNestedSession = () => {
			void this.input.session.abort();
		};
		this.input.signal?.addEventListener("abort", abortNestedSession, { once: true });

		let capturedResponse: CapturedAgentResponse = { called: false };
		try {
			this.input.signal?.throwIfAborted();
			await this.input.session.prompt(withResponseToolInstruction(agentInput.prompt, agentInput.response, this.label, responseRunId, attempt, previousError), {
				source: "extension",
			});
			this.input.signal?.throwIfAborted();
			capturedResponse = this.input.responseCollector.get(responseRunId);
		} finally {
			this.input.signal?.removeEventListener("abort", abortNestedSession);
			releaseResponseSlot();
			unsubscribe();
		}

		return {
			text: text.trim(),
			messages,
			responseToolCalled: capturedResponse.called,
			usage: usageFromMessages(messages),
			toolResponse: capturedResponse.response,
			sessionFile: this.input.session.sessionFile,
		};
	}
}

function usageFromMessages(messages: readonly unknown[]): WorkflowUsage {
	return totalWorkflowUsage(messages.map(usageFromMessage).filter((usage): usage is WorkflowUsage => usage !== undefined));
}

function usageFromMessage(message: unknown): WorkflowUsage | undefined {
	if (!message || typeof message !== "object" || !("usage" in message)) return undefined;
	return workflowUsageFromValue((message as { usage?: unknown }).usage) ?? emptyWorkflowUsage();
}

function withResponseToolInstruction(
	prompt: string,
	responseSchema: z.ZodType,
	label: string,
	responseRunId: string,
	attempt: number,
	previousError: string | undefined,
): string {
	return [
		prompt,
		"",
		"Structured workflow response:",
		`Use the ${AGENT_RESPONSE_TOOL_NAME} tool as your final action to record the workflow response.`,
		"Do not emit the workflow response as assistant text or Markdown.",
		`Pass runId exactly as: ${responseRunId}`,
		`Pass label exactly as: ${label}`,
		"Pass the structured workflow response in the tool's response argument.",
		"The response argument must match this JSON Schema:",
		JSON.stringify(z.toJSONSchema(responseSchema), null, 2),
		...(attempt > 1 && previousError ? ["", `Previous structured response attempt failed: ${previousError}`] : []),
	].join("\n");
}

function withAgentResponseTool(tools: readonly string[] | undefined): string[] {
	if (!tools) return [...DEFAULT_AGENT_TOOL_ALLOWLIST];
	return Array.from(new Set([...tools, AGENT_RESPONSE_TOOL_NAME]));
}
