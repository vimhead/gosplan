import { randomUUID } from "node:crypto";
import { mkdir, readFile, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { PalantirRunHealth } from "../api.ts";
import { isNodeError } from "./errors.ts";
import { writeJsonAtomically } from "./json-file.ts";

const LOCK_DIR_NAME = "active.lock";
const OWNER_FILE_NAME = "owner.json";
const HEARTBEAT_INTERVAL_MS = 15_000;
const HEARTBEAT_TTL_MS = 60_000;
const ACQUIRE_ATTEMPTS = 5;

export type PalantirRunLeaseOwner = {
	readonly token: string;
	readonly acquiredAt: string;
	readonly heartbeatAt: string;
	readonly pid: number;
	readonly processGroupId: number;
	readonly command: readonly string[];
};

export class PalantirRunLease {
	private heartbeat: ReturnType<typeof setInterval> | undefined;
	private heartbeatChain: Promise<void> = Promise.resolve();
	private isReleased = false;

	private constructor(
		private readonly lockRoot: string,
		private readonly token: string,
		private readonly processOwner: PalantirRunProcessOwner,
	) {}

	static async acquire(runRoot: string, processOwner: PalantirRunProcessOwner = currentRunProcessOwner()): Promise<PalantirRunLease> {
		const lockRoot = join(runRoot, LOCK_DIR_NAME);
		for (let attempt = 1; attempt <= ACQUIRE_ATTEMPTS; attempt++) {
			try {
				await mkdir(lockRoot);
				const lease = new PalantirRunLease(lockRoot, randomUUID(), processOwner);
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
				const owner = await readRunLeaseOwner(join(lockRoot, OWNER_FILE_NAME));
				const isStale = owner ? isRunLeaseStale(owner) : await isRunLeaseDirectoryStale(lockRoot);
				if (!isStale) throw new Error(`Run is already active: ${runRoot}`);
				await rm(lockRoot, { recursive: true, force: true });
			}
		}
		throw new Error(`Could not acquire run lease: ${runRoot}`);
	}

	async assertOwned(): Promise<void> {
		if (this.isReleased) throw new Error("Run lease has been released");
		const owner = await readRunLeaseOwner(this.ownerPath);
		if (!owner || owner.token !== this.token) throw new Error("Run lease was lost");
	}

	async release(): Promise<void> {
		if (this.isReleased) return;
		this.isReleased = true;
		if (this.heartbeat) clearInterval(this.heartbeat);
		await this.heartbeatChain.catch(() => undefined);
		const owner = await readRunLeaseOwner(this.ownerPath);
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
		const owner = await readRunLeaseOwner(this.ownerPath);
		if (!owner || owner.token !== this.token) throw new Error("Run lease was lost");
		await this.writeOwner({ acquiredAt: owner.acquiredAt });
	}

	private async writeOwner(input: { readonly acquiredAt: string }): Promise<void> {
		const now = new Date().toISOString();
		await writeJsonAtomically(this.ownerPath, { token: this.token, acquiredAt: input.acquiredAt, heartbeatAt: now, ...this.processOwner });
	}
}

export type PalantirRunProcessOwner = {
	readonly pid: number;
	readonly processGroupId: number;
	readonly command: readonly string[];
};

export async function getRunLeaseHealth(runRoot: string): Promise<PalantirRunHealth> {
	const lockRoot = join(runRoot, LOCK_DIR_NAME);
	const owner = await readRunLeaseOwner(join(lockRoot, OWNER_FILE_NAME));
	if (owner) return isRunLeaseStale(owner) ? "unhealthy" : "healthy";
	return await isRunLeaseDirectoryStale(lockRoot) ? "unhealthy" : "healthy";
}

export async function getRunLeaseOwner(runRoot: string): Promise<PalantirRunLeaseOwner | undefined> {
	return readRunLeaseOwner(join(runRoot, LOCK_DIR_NAME, OWNER_FILE_NAME));
}

function currentRunProcessOwner(): PalantirRunProcessOwner {
	return {
		pid: process.pid,
		processGroupId: process.pid,
		command: process.argv,
	};
}

async function readRunLeaseOwner(path: string): Promise<PalantirRunLeaseOwner | undefined> {
	try {
		return parseRunLeaseOwner(JSON.parse(await readFile(path, "utf8")));
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return undefined;
		return undefined;
	}
}

function parseRunLeaseOwner(value: unknown): PalantirRunLeaseOwner | undefined {
	if (!value || typeof value !== "object") return undefined;
	const owner = value as Partial<PalantirRunLeaseOwner>;
	if (typeof owner.token !== "string" || owner.token.length === 0) return undefined;
	if (typeof owner.acquiredAt !== "string" || Number.isNaN(Date.parse(owner.acquiredAt))) return undefined;
	if (typeof owner.heartbeatAt !== "string" || Number.isNaN(Date.parse(owner.heartbeatAt))) return undefined;
	const pid = typeof owner.pid === "number" && Number.isInteger(owner.pid) ? owner.pid : 0;
	const processGroupId = typeof owner.processGroupId === "number" && Number.isInteger(owner.processGroupId) ? owner.processGroupId : pid;
	const command = Array.isArray(owner.command) ? owner.command.filter((value): value is string => typeof value === "string") : [];
	return { token: owner.token, acquiredAt: owner.acquiredAt, heartbeatAt: owner.heartbeatAt, pid, processGroupId, command };
}

function isRunLeaseStale(owner: PalantirRunLeaseOwner): boolean {
	return Date.now() - Date.parse(owner.heartbeatAt) > HEARTBEAT_TTL_MS;
}

async function isRunLeaseDirectoryStale(lockRoot: string): Promise<boolean> {
	try {
		return Date.now() - (await stat(lockRoot)).mtimeMs > HEARTBEAT_TTL_MS;
	} catch (error) {
		if (isNodeError(error) && error.code === "ENOENT") return true;
		throw error;
	}
}
