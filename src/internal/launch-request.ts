import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomically } from "./json-file.ts";

export const LAUNCH_REQUEST_FILE_NAME = "launch-request.json";
export const RESUME_REQUEST_FILE_NAME = "resume-request.json";

export type WorkflowLaunchRequest = {
	readonly version: 1;
	readonly type: "run";
	readonly id: string;
	readonly name: string;
	readonly workflowId: string;
	readonly params: unknown;
	readonly configOverride?: unknown;
	readonly createdAt: string;
};

export type WorkflowResumeRequest = {
	readonly version: 1;
	readonly type: "resume";
	readonly id: string;
	readonly params?: unknown;
	readonly createdAt: string;
};

export async function writeWorkflowLaunchRequest(runRoot: string, request: WorkflowLaunchRequest): Promise<void> {
	await writeJsonAtomically(join(runRoot, LAUNCH_REQUEST_FILE_NAME), request);
}

export async function readWorkflowLaunchRequest(runRoot: string): Promise<WorkflowLaunchRequest> {
	return parseWorkflowLaunchRequest(JSON.parse(await readFile(join(runRoot, LAUNCH_REQUEST_FILE_NAME), "utf8")));
}

export async function writeWorkflowResumeRequest(runRoot: string, request: WorkflowResumeRequest): Promise<void> {
	await writeJsonAtomically(join(runRoot, RESUME_REQUEST_FILE_NAME), request);
}

export async function readWorkflowResumeRequest(runRoot: string): Promise<WorkflowResumeRequest> {
	return parseWorkflowResumeRequest(JSON.parse(await readFile(join(runRoot, RESUME_REQUEST_FILE_NAME), "utf8")));
}

function parseWorkflowLaunchRequest(value: unknown): WorkflowLaunchRequest {
	if (!value || typeof value !== "object") throw new Error("Invalid workflow launch request");
	const request = value as Partial<WorkflowLaunchRequest>;
	if (request.version !== 1 || request.type !== "run") throw new Error("Unsupported workflow launch request");
	if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Invalid workflow launch request id");
	if (typeof request.name !== "string" || request.name.length === 0) throw new Error("Invalid workflow launch request name");
	if (typeof request.workflowId !== "string" || request.workflowId.length === 0) throw new Error("Invalid workflow launch request workflow id");
	if (typeof request.createdAt !== "string" || Number.isNaN(Date.parse(request.createdAt))) throw new Error("Invalid workflow launch request timestamp");
	return request as WorkflowLaunchRequest;
}

function parseWorkflowResumeRequest(value: unknown): WorkflowResumeRequest {
	if (!value || typeof value !== "object") throw new Error("Invalid workflow resume request");
	const request = value as Partial<WorkflowResumeRequest>;
	if (request.version !== 1 || request.type !== "resume") throw new Error("Unsupported workflow resume request");
	if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Invalid workflow resume request id");
	if (typeof request.createdAt !== "string" || Number.isNaN(Date.parse(request.createdAt))) throw new Error("Invalid workflow resume request timestamp");
	return request as WorkflowResumeRequest;
}
