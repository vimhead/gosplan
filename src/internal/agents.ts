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
import type { NornAgentCreateSessionInput, NornAgentPromptInput, NornAgentRunRawAttempt, NornAgentRunResult, NornAgentSessionEvents, NornAgentSession, NornAgentSinglePromptInput, NornAgentUsage } from "../api.ts";
import {
	AGENT_RESPONSE_TOOL_NAME,
	NornAgentResponseCollector,
	NornAgentResponseToolFactory,
	type NornCapturedAgentResponse,
} from "./agent-response-tool.ts";
import { errorMessage } from "./errors.ts";
import type { NornRunLogs } from "./logs.ts";
import { safeFileName } from "./file-names.ts";
import type { NornRunLogger } from "./run-log.ts";
import { agentUsageFromValue, emptyAgentUsage, totalAgentUsage } from "./usage.ts";

const DEFAULT_AGENT_ATTEMPTS = 3;
const DEFAULT_AGENT_TOOL_ALLOWLIST = ["read", "bash", "edit", "write", AGENT_RESPONSE_TOOL_NAME] as const;

type NornAgentRunnerInput = {
	readonly id: string;
	readonly runRoot: string;
	readonly boundaryRoot: string;
	readonly boundaryName: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly model?: CreateAgentSessionOptions["model"];
	readonly thinkingLevel?: CreateAgentSessionOptions["thinkingLevel"];
	readonly agentDir?: string;
	readonly logs: NornRunLogs;
	readonly logger: NornRunLogger;
	readonly responseCollector: NornAgentResponseCollector;
};

type CreatedNornAgentSessionInput = NornAgentRunnerInput & {
	readonly label: string;
	readonly cwd: string;
	readonly session: AgentSession;
	readonly events: NornAgentSessionEvents;
};

export class NornAgentRunner {
	private readonly responseToolFactory: NornAgentResponseToolFactory;

	constructor(private readonly input: NornAgentRunnerInput) {
		this.responseToolFactory = new NornAgentResponseToolFactory(input.responseCollector);
	}

	async createSession(agentInput: NornAgentCreateSessionInput): Promise<NornAgentSession> {
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

		try {
			await agentInput.beforeSessionStart?.({ events: eventBus });
			await session.bindExtensions({});
		} catch (error) {
			session.dispose();
			throw error;
		}

		await this.input.logger.record({ type: "agent.spawned", label: agentInput.label, cwd });
		return new CreatedNornAgentSession({
			...this.input,
			label: agentInput.label,
			cwd,
			session,
			events: eventBus,
		});
	}

	async prompt<ResponseSchema extends z.ZodType>(agentInput: NornAgentSinglePromptInput<ResponseSchema>): Promise<z.output<ResponseSchema>> {
		const agent = await this.createSession(agentInput);
		try {
			return await agent.prompt(agentInput);
		} finally {
			await agent.dispose();
		}
	}

	private resolveFromCwd(path: string): string {
		const resolvedPath = isAbsolute(path) ? path : resolve(this.input.cwd, path);
		const pathFromBoundary = relative(this.input.boundaryRoot, resolvedPath);
		if (pathFromBoundary === ".." || pathFromBoundary.startsWith(`..${sep}`) || isAbsolute(pathFromBoundary)) {
			throw new Error(`Agent cwd escapes ${this.input.boundaryName} isolation: ${path}`);
		}
		return resolvedPath;
	}
}

class CreatedNornAgentSession implements NornAgentSession {
	readonly label: string;
	readonly cwd: string;
	readonly events: NornAgentSessionEvents;
	private isDisposed = false;

	constructor(private readonly input: CreatedNornAgentSessionInput) {
		this.label = input.label;
		this.cwd = input.cwd;
		this.events = input.events;
	}

	async prompt<ResponseSchema extends z.ZodType>(agentInput: NornAgentPromptInput<ResponseSchema>): Promise<z.output<ResponseSchema>> {
		return (await this.promptWithResult(agentInput)).response;
	}

	private async promptWithResult<ResponseSchema extends z.ZodType>(agentInput: NornAgentPromptInput<ResponseSchema>): Promise<NornAgentRunResult<ResponseSchema>> {
		if (this.isDisposed) throw new Error(`Workflow agent session is disposed: ${this.label}`);
		const maxAttempts = Math.max(1, Math.floor(agentInput.maxAttempts ?? DEFAULT_AGENT_ATTEMPTS));
		const attempts: NornAgentRunRawAttempt[] = [];
		const startedAtMs = Date.now();
		let isTerminalEventRecorded = false;
		await this.input.logger.record({ type: "agent.started", label: this.label, cwd: this.cwd, maxAttempts });

		try {
			for (let attempt = 1; attempt <= maxAttempts; attempt++) {
				await this.input.logger.record({ type: "agent.attempt.started", label: this.label, attempt });
				const raw = await this.runAttempt(agentInput, attempt, attempts.at(-1)?.error);
				const rawAttempt: NornAgentRunRawAttempt = { attempt, ...raw };
				attempts.push(rawAttempt);

				try {
					if (!raw.responseToolCalled) throw new Error(`Agent did not call ${AGENT_RESPONSE_TOOL_NAME}`);
					const response = agentInput.response.parse(raw.toolResponse);
					const usage = totalAgentUsage(attempts.map((candidate) => candidate.usage));
					const result: NornAgentRunResult<ResponseSchema> = {
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
						const usage = totalAgentUsage(attempts.map((candidate) => candidate.usage));
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
					usage: totalAgentUsage(attempts.map((candidate) => candidate.usage)),
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
		agentInput: NornAgentPromptInput<ResponseSchema>,
		attempt: number,
		previousError: string | undefined,
	): Promise<Omit<NornAgentRunRawAttempt, "attempt" | "error">> {
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

		let capturedResponse: NornCapturedAgentResponse = { called: false };
		try {
			this.input.signal?.throwIfAborted();
			await this.input.session.prompt(withResponseToolInstruction(agentInput.prompt, agentInput.response, this.label, responseRunId, attempt, previousError), {
				...agentInput.options,
				source: agentInput.options?.source ?? "extension",
			});
			this.input.signal?.throwIfAborted();
			capturedResponse = this.input.responseCollector.get(responseRunId);
			if (!capturedResponse.called) {
				await this.promptForStructuredResponse(agentInput, responseRunId, attempt, previousError);
				this.input.signal?.throwIfAborted();
				capturedResponse = this.input.responseCollector.get(responseRunId);
			}
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

	private async promptForStructuredResponse<ResponseSchema extends z.ZodType>(
		agentInput: NornAgentPromptInput<ResponseSchema>,
		responseRunId: string,
		attempt: number,
		previousError: string | undefined,
	): Promise<void> {
		const activeToolNames = this.input.session.getActiveToolNames();
		await this.input.logger.record({ type: "agent.response-finalization.started", label: this.label, attempt });
		this.input.session.setActiveToolsByName([AGENT_RESPONSE_TOOL_NAME]);
		try {
			await this.input.session.prompt(withResponseToolFinalizationInstruction(agentInput.response, this.label, responseRunId, attempt, previousError), {
				...agentInput.options,
				source: agentInput.options?.source ?? "extension",
			});
			await this.input.logger.record({ type: "agent.response-finalization.completed", label: this.label, attempt });
		} catch (error) {
			await this.input.logger.record({ type: "agent.response-finalization.failed", label: this.label, attempt, error: errorMessage(error) });
			throw error;
		} finally {
			this.input.session.setActiveToolsByName(activeToolNames);
		}
	}
}

function usageFromMessages(messages: readonly unknown[]): NornAgentUsage {
	return totalAgentUsage(messages.map(usageFromMessage).filter((usage): usage is NornAgentUsage => usage !== undefined));
}

function usageFromMessage(message: unknown): NornAgentUsage | undefined {
	if (!message || typeof message !== "object" || !("usage" in message)) return undefined;
	return agentUsageFromValue((message as { usage?: unknown }).usage) ?? emptyAgentUsage();
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

function withResponseToolFinalizationInstruction(
	responseSchema: z.ZodType,
	label: string,
	responseRunId: string,
	attempt: number,
	previousError: string | undefined,
): string {
	return [
		"Your previous workflow response turn ended without recording the structured response.",
		`Use the ${AGENT_RESPONSE_TOOL_NAME} tool now. It is the only active tool for this turn.`,
		"Do not answer in assistant text or Markdown.",
		`Pass runId exactly as: ${responseRunId}`,
		`Pass label exactly as: ${label}`,
		"Pass the structured workflow response in the tool's response argument, based on the work you already completed in this session.",
		"The response argument must match this JSON Schema:",
		JSON.stringify(z.toJSONSchema(responseSchema), null, 2),
		...(attempt > 1 && previousError ? ["", `Previous structured response attempt failed: ${previousError}`] : []),
	].join("\n");
}

function withAgentResponseTool(tools: readonly string[] | undefined): string[] {
	if (!tools) return [...DEFAULT_AGENT_TOOL_ALLOWLIST];
	return Array.from(new Set([...tools, AGENT_RESPONSE_TOOL_NAME]));
}
