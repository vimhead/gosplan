import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomically } from "./json-file.ts";

export const LAUNCH_REQUEST_FILE_NAME = "launch-request.json";
export const RESUME_REQUEST_FILE_NAME = "resume-request.json";

export type PalantirRunLaunchRequest = {
	readonly version: 1;
	readonly type: "run";
	readonly id: string;
	readonly name: string;
	readonly workflowId: string;
	readonly params: unknown;
	readonly configOverride?: unknown;
	readonly createdAt: string;
};

export type PalantirRunResumeRequest = {
	readonly version: 1;
	readonly type: "resume";
	readonly id: string;
	readonly params?: unknown;
	readonly createdAt: string;
};

export async function writeRunLaunchRequest(runRoot: string, request: PalantirRunLaunchRequest): Promise<void> {
	await writeJsonAtomically(join(runRoot, LAUNCH_REQUEST_FILE_NAME), request);
}

export async function readRunLaunchRequest(runRoot: string): Promise<PalantirRunLaunchRequest> {
	return parseRunLaunchRequest(JSON.parse(await readFile(join(runRoot, LAUNCH_REQUEST_FILE_NAME), "utf8")));
}

export async function writeRunResumeRequest(runRoot: string, request: PalantirRunResumeRequest): Promise<void> {
	await writeJsonAtomically(join(runRoot, RESUME_REQUEST_FILE_NAME), request);
}

export async function readRunResumeRequest(runRoot: string): Promise<PalantirRunResumeRequest> {
	return parseRunResumeRequest(JSON.parse(await readFile(join(runRoot, RESUME_REQUEST_FILE_NAME), "utf8")));
}

function parseRunLaunchRequest(value: unknown): PalantirRunLaunchRequest {
	if (!value || typeof value !== "object") throw new Error("Invalid workflow launch request");
	const request = value as Partial<PalantirRunLaunchRequest>;
	if (request.version !== 1 || request.type !== "run") throw new Error("Unsupported workflow launch request");
	if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Invalid workflow launch request id");
	if (typeof request.name !== "string" || request.name.length === 0) throw new Error("Invalid workflow launch request name");
	if (typeof request.workflowId !== "string" || request.workflowId.length === 0) throw new Error("Invalid workflow launch request workflow id");
	if (typeof request.createdAt !== "string" || Number.isNaN(Date.parse(request.createdAt))) throw new Error("Invalid workflow launch request timestamp");
	return request as PalantirRunLaunchRequest;
}

function parseRunResumeRequest(value: unknown): PalantirRunResumeRequest {
	if (!value || typeof value !== "object") throw new Error("Invalid workflow resume request");
	const request = value as Partial<PalantirRunResumeRequest>;
	if (request.version !== 1 || request.type !== "resume") throw new Error("Unsupported workflow resume request");
	if (typeof request.id !== "string" || request.id.length === 0) throw new Error("Invalid workflow resume request id");
	if (typeof request.createdAt !== "string" || Number.isNaN(Date.parse(request.createdAt))) throw new Error("Invalid workflow resume request timestamp");
	return request as PalantirRunResumeRequest;
}
