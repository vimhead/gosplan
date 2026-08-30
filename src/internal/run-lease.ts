import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { WorkflowRunHealth } from "../api.ts";
import { isNodeError } from "./errors.ts";
import { writeJsonAtomically } from "./json-file.ts";

const LOCK_DIR_NAME = "active.lock";
const OWNER_FILE_NAME = "owner.json";
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TTL_MS = 60_000;
const ACQUIRE_ATTEMPTS = 5;

export type WorkflowRunLeaseOwner = {
	readonly token: string;
	readonly acquiredAt: string;
	readonly heartbeatAt: string;
	readonly pid: number;
	readonly processGroupId: number;
	readonly command: readonly string[];
};

export class WorkflowRunLease {
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private heartbeatChain: Promise<void> = Promise.resolve();
	private isReleased = false;

	private constructor(
		private readonly lockRoot: string,
		private readonly token: string,
		private readonly processOwner: WorkflowRunProcessOwner,
	) {}

	static async acquire(runRoot: string, processOwner: WorkflowRunProcessOwner = currentWorkflowRunProcessOwner()): Promise<WorkflowRunLease> {
		const lockRoot = join(runRoot, LOCK_DIR_NAME);
		for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt++) {
			try {
				await mkdir(lockRoot);
				const lease = new WorkflowRunLease(lockRoot, randomUUID(), processOwner);
				try {
					await lease.writeOwner({ acquiredAt: new Date().toISOString() });
				} catch (error) {
					await rm(lockRoot, { recursive: true, force: true });
					throw error;
				}
				lease.startHeartbeat();
				return lease;
			} catch (error) {
				if (!isNodeError(error) || error.code !== "EEXIST") throw error;
				const owner = await readWorkflowRunLeaseOwner(join(lockRoot, OWNER_FILE_NAME));
				const isStale = owner ? isWorkflowRunLeaseStale(owner) : await isWorkflowRunLeaseDirectoryStale(lockRoot);
				if (!isStale) throw new Error(`Workflow run is already active: ${runRoot}`);
				await rm(lockRoot, { recursive: true, force: true });
			}
		}
		throw new Error(`Could not acquire workflow run lease: ${runRoot}`);
	}

	async assertOwned(): Promise<void> {
		if (this.isReleased) throw new Error("Workflow run lease has been released");
		const owner = await readWorkflowRunLeaseOwner(this.ownerPath);
		if (!owner || owner.token !== this.token) throw new Error("Workflow run lease was lost");
	}

	async release(): Promise<void> {
		if (this.isReleased) return;
		this.isReleased = true;
		if (this.heartbeat) clearInterval(this.heartbeat);
		await this.heartbeatChain.catch(() => undefined);
		const owner = await readWorkflowRunLeaseOwner(this.ownerPath);
		if (owner?.token === this.token) await rm(this.lockRoot, { recursive: true, force: true });
	}

	private get ownerPath(): string {
		return join(this.lockRoot, OWNER_FILE_NAME);
	}

	private startHeartbeat(): void {
		this.heartbeat = setInterval(() => {
			this.heartbeatChain = this.heartbeatChain.then(() => this.refreshHeartbeat()).catch(() => {
				this.isReleased = true;
				if (this.heartbeat) clearInterval(this.heartbeat);
			});
		}, HEARTBEAT_INTERVAL_MS);
		this.heartbeat.unref?.();
	}

	private async refreshHeartbeat(): Promise<void> {
		if (this.isReleased) return;
		const owner = await readWorkflowRunLeaseOwner(this.ownerPath);
		if (!owner || owner.token !== this.token) throw new Error("Workflow run lease was lost");
		await this.writeOwner({ acquiredAt: owner.acquiredAt });
	}

	private async writeOwner(input: { readonly acquiredAt: string }): Promise<void> {
		const now = new Date().toISOString();
		await writeJsonAtomically(this.ownerPath, { token: this.token, acquiredAt: input.acquiredAt, heartbeatAt: now, ...this.processOwner });
	}
}

export type WorkflowRunProcessOwner = {
	readonly pid: number;
	readonly processGroupId: number;
	readonly command: readonly string[];
};

export async function getWorkflowRunLeaseHealth(runRoot: string): Promise<WorkflowRunHealth> {
	const lockRoot = join(runRoot, LOCK_DIR_NAME);
	const owner = await readWorkflowRunLeaseOwner(join(lockRoot, OWNER_FILE_NAME));
	if (owner) return isWorkflowRunLeaseStale(owner) ? "unhealthy" : "healthy";
	return await isWorkflowRunLeaseDirectoryStale(lockRoot) ? "unhealthy" : "healthy";
}

export async function getWorkflowRunLeaseOwner(runRoot: string): Promise<WorkflowRunLeaseOwner | undefined> {
	return readWorkflowRunLeaseOwner(join(runRoot, LOCK_DIR_NAME, OWNER_FILE_NAME));
}

function currentWorkflowRunProcessOwner(): WorkflowRunProcessOwner {
	return {
		pid: process.pid,
		processGroupId: process.pid,
		command: process.argv,
	};
}

async function readWorkflowRunLeaseOwner(path: string): Promise<WorkflowRunLeaseOwner | undefined> {
	try {
		return parseWorkflowRunLeaseOwner(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		return undefined;
	}
}

function parseWorkflowRunLeaseOwner(value: unknown): WorkflowRunLeaseOwner | undefined {
	if (!value || typeof value !== "object") return undefined;
	const owner = value as Partial<WorkflowRunLeaseOwner>;
	if (typeof owner.token !== "string" || owner.token.length === 0) return undefined;
	if (typeof owner.acquiredAt !== "string" || Number.isNaN(Date.parse(owner.acquiredAt))) return undefined;
	if (typeof owner.heartbeatAt !== "string" || Number.isNaN(Date.parse(owner.heartbeatAt))) return undefined;
	const pid = typeof owner.pid === "number" && Number.isInteger(owner.pid) ? owner.pid : 0;
	const processGroupId = typeof owner.processGroupId === "number" && Number.isInteger(owner.processGroupId) ? owner.processGroupId : pid;
	const command = Array.isArray(owner.command) ? owner.command.filter((value): value is string => typeof value === "string") : [];
	return { token: owner.token, acquiredAt: owner.acquiredAt, heartbeatAt: owner.heartbeatAt, pid, processGroupId, command };
}

function isWorkflowRunLeaseStale(owner: WorkflowRunLeaseOwner): boolean {
	return Date.now() - Date.parse(owner.heartbeatAt) > HEARTBEAT_TTL_MS;
}

async function isWorkflowRunLeaseDirectoryStale(lockRoot: string): Promise<boolean> {
	try {
		return Date.now() - (await stat(lockRoot)).mtimeMs > HEARTBEAT_TTL_MS;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return true;
		throw error;
	}
}
