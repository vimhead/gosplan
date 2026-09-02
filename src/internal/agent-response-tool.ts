import { defineTool, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { z } from "zod";
import type { NornDispose } from "../api.ts";
import { zodErrorMessage } from "./errors.ts";

export const AGENT_RESPONSE_TOOL_NAME = "pi_workflows_agent_response";

export type NornCapturedAgentResponse = {
	readonly called: boolean;
	readonly response?: unknown;
};

type PendingAgentResponse = {
	readonly label: string;
	readonly responseSchema: z.ZodType;
	called: boolean;
	response?: unknown;
};

type AgentResponseToolDetails = {
	readonly valid: boolean;
	readonly error?: string;
	readonly runId?: string;
	readonly label?: string;
	readonly response?: unknown;
};

export class NornAgentResponseCollector {
	private readonly pending = new Map<string, PendingAgentResponse>();

	begin(runId: string, label: string, responseSchema: z.ZodType): NornDispose {
		this.pending.set(runId, { label, responseSchema, called: false });
		return () => this.pending.delete(runId);
	}

	capture(runId: string, label: string, response: unknown): { label: string; response: unknown } {
		const pending = this.pending.get(runId);
		if (!pending) throw new Error(`No active workflow agent response slot: ${runId}`);
		if (pending.label !== label) {
			throw new Error(`Workflow agent response label mismatch: expected ${pending.label}, received ${label}`);
		}
		if (pending.called) throw new Error(`Workflow agent response already recorded for ${runId}`);
		const parsed = pending.responseSchema.safeParse(response);
		if (!parsed.success) throw new Error(zodErrorMessage(parsed.error));
		pending.called = true;
		pending.response = parsed.data;
		return { label: pending.label, response: parsed.data };
	}

	get(runId: string): NornCapturedAgentResponse {
		const pending = this.pending.get(runId);
		return pending ? { called: pending.called, response: pending.response } : { called: false };
	}
}

export class NornAgentResponseToolFactory {
	constructor(private readonly responseCollector: NornAgentResponseCollector) {}

	create(): ToolDefinition {
		const responseCollector = this.responseCollector;
		return defineTool({
			name: AGENT_RESPONSE_TOOL_NAME,
			label: "Workflow Agent Response",
			description: "Record the final structured response for a Norn nested agent run.",
			promptSnippet: "Record a final structured response for Norn agent automation",
			promptGuidelines: [
				`Use ${AGENT_RESPONSE_TOOL_NAME} as your final action when a workflow prompt gives you a workflow response runId.`,
				`After calling ${AGENT_RESPONSE_TOOL_NAME}, do not emit another assistant response in the same turn.`,
			],
			parameters: Type.Object({
				runId: Type.String({ description: "The exact workflow response runId provided in the prompt." }),
				label: Type.String({ description: "The exact workflow agent label provided in the prompt." }),
				response: Type.Unknown({ description: "The structured response object requested by the workflow." }),
			}),
			async execute(_toolCallId, params) {
				try {
					const captured = responseCollector.capture(params.runId, params.label, params.response);
					return {
						content: [{ type: "text", text: `Recorded workflow agent response for ${captured.label}.` }],
						details: { valid: true, runId: params.runId, label: captured.label, response: captured.response } as AgentResponseToolDetails,
						terminate: true,
					};
				} catch (error) {
					return invalidAgentResponseToolResult(error instanceof Error ? error.message : String(error));
				}
			},
		});
	}
}

function invalidAgentResponseToolResult(error: string) {
	return {
		content: [{ type: "text" as const, text: `Invalid workflow agent response: ${error}. Call the tool again with a corrected response.` }],
		details: { valid: false, error } as AgentResponseToolDetails,
	};
}
