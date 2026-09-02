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
import type { NornAgentInitialEvent, NornAgentPromptInput, NornAgentRunInput, NornAgentRunRawAttempt, NornAgentRunResult, NornAgentSessionEvents, NornAgentSpawnInput, NornAgentSession, NornAgentUsage } from "../api.ts";
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

type SpawnedNornAgentSessionInput = NornAgentRunnerInput & {
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

	async spawn(agentInput: NornAgentSpawnInput): Promise<NornAgentSession> {
		const cwd = agentInput.cwd ? this.resolveFromCwd(agentInput.cwd) : this.input.cwd;
		const sessionDir = resolve(this.input.runRoot, "sessions");
		await mkdir(sessionDir, { recursive: true });

		const eventBus = createEventBus();
		const agentDir = this.input.agentDir ?? getAgentDir();
		const loader = new DefaultResourceLoader({ cwd, agentDir, eventBus });
		await loader.reload();
		emitInitialEvents(eventBus, agentInput.initialEvents);
		const { session } = await createAgentSession({
			cwd,
			resourceLoader: loader,
			sessionManager: SessionManager.create(cwd, sessionDir),
			tools: withAgentResponseTool(agentInput.tools),
			customTools: [this.responseToolFactory.create()],
			model: agentInput.model ?? this.input.model,
			thinkingLevel: agentInput.thinkingLevel ?? this.input.thinkingLevel,
		});
		await bindExtensionsForInitialEvents(session, agentInput.initialEvents);

		await this.input.logger.record({ type: "agent.spawned", label: agentInput.label, cwd });
		return new SpawnedNornAgentSession({
			...this.input,
			label: agentInput.label,
			cwd,
			session,
			events: eventBus,
		});
	}

	async run<ResponseSchema extends z.ZodType>(agentInput: NornAgentRunInput<ResponseSchema>): Promise<NornAgentRunResult<ResponseSchema>> {
		const agent = await this.spawn(agentInput);
		try {
			return await agent.run(agentInput);
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

class SpawnedNornAgentSession implements NornAgentSession {
	readonly label: string;
	readonly cwd: string;
	readonly events: NornAgentSessionEvents;
	private isDisposed = false;

	constructor(private readonly input: SpawnedNornAgentSessionInput) {
		this.label = input.label;
		this.cwd = input.cwd;
		this.events = input.events;
	}

	async run<ResponseSchema extends z.ZodType>(agentInput: NornAgentPromptInput<ResponseSchema>): Promise<NornAgentRunResult<ResponseSchema>> {
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

function emitInitialEvents(eventBus: NornAgentSessionEvents, events: readonly NornAgentInitialEvent[] | undefined): void {
	for (const event of events ?? []) {
		eventBus.emit(event.name, event.data);
	}
}

async function bindExtensionsForInitialEvents(session: AgentSession, events: readonly NornAgentInitialEvent[] | undefined): Promise<void> {
	if ((events?.length ?? 0) === 0) return;
	await session.bindExtensions({});
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

function withAgentResponseTool(tools: readonly string[] | undefined): string[] {
	if (!tools) return [...DEFAULT_AGENT_TOOL_ALLOWLIST];
	return Array.from(new Set([...tools, AGENT_RESPONSE_TOOL_NAME]));
}
