import { spawn } from "node:child_process";
import { isAbsolute, relative, resolve, sep } from "node:path";
import type { WriteStream } from "node:fs";
import type { NornCommandRunInput, NornCommandRunResult, NornLogRef } from "../api.ts";
import { errorMessage } from "./errors.ts";
import { safeFileName } from "./file-names.ts";
import type { NornRunLogs } from "./logs.ts";
import type { NornRunLogger } from "./run-log.ts";

type NornCommandRunnerInput = {
	readonly boundaryRoot: string;
	readonly boundaryName: string;
	readonly cwd: string;
	readonly signal?: AbortSignal;
	readonly logs: NornRunLogs;
	readonly logger: NornRunLogger;
};

export class NornCommandRunner {
	constructor(private readonly input: NornCommandRunnerInput) {}

	async run(commandInput: NornCommandRunInput): Promise<NornCommandRunResult> {
		const cwd = this.resolveFromCwd(commandInput.cwd ?? this.input.cwd);
		const startedAtMs = Date.now();
		await this.input.logger.record({ type: "command.started", label: commandInput.label, command: commandInput.command, cwd });
		let result: SpawnCommandResult;
		const stdoutLog = await this.input.logs.createWriteStream(commandLog(commandInput.label, "stdout"));
		const stderrLog = await this.input.logs.createWriteStream(commandLog(commandInput.label, "stderr"));
		try {
			result = await spawnCommand({
				command: commandInput.command,
				cwd,
				env: { ...process.env, ...(commandInput.env ?? {}) },
				timeoutMs: commandInput.timeoutMs,
				signal: this.input.signal,
				stdoutStream: stdoutLog.stream,
				stderrStream: stderrLog.stream,
			});
		} catch (error) {
			await this.input.logger.record({ type: "command.failed", label: commandInput.label, durationMs: Date.now() - startedAtMs, error: errorMessage(error) });
			throw error;
		}
		const commandResult = {
			label: commandInput.label,
			command: commandInput.command,
			cwd,
			exitCode: result.exitCode,
			stdoutTail: result.stdoutTail,
			stderrTail: result.stderrTail,
			killed: result.killed,
			stdoutLog: stdoutLog.log,
			stderrLog: stderrLog.log,
		};
		await this.input.logger.record({
			type: "command.completed",
			label: commandInput.label,
			durationMs: Date.now() - startedAtMs,
			exitCode: result.exitCode,
			killed: result.killed,
			stdoutLogId: commandResult.stdoutLog.id,
			stderrLogId: commandResult.stderrLog.id,
		});
		return commandResult;
	}

	private resolveFromCwd(path: string): string {
		const resolvedPath = isAbsolute(path) ? path : resolve(this.input.cwd, path);
		const pathFromBoundary = relative(this.input.boundaryRoot, resolvedPath);
		if (pathFromBoundary === ".." || pathFromBoundary.startsWith(`..${sep}`) || isAbsolute(pathFromBoundary)) {
			throw new Error(`Command cwd escapes ${this.input.boundaryName} isolation: ${path}`);
		}
		return resolvedPath;
	}
}

type SpawnCommandInput = {
	command: string | readonly [string, ...string[]];
	cwd: string;
	env: NodeJS.ProcessEnv;
	timeoutMs?: number;
	signal?: AbortSignal;
	stdoutStream: WriteStream;
	stderrStream: WriteStream;
};

type SpawnCommandResult = {
	exitCode: number | null;
	stdoutTail: string;
	stderrTail: string;
	killed: boolean;
};

async function spawnCommand(input: SpawnCommandInput): Promise<SpawnCommandResult> {
	const command = typeof input.command === "string" ? "bash" : input.command[0];
	const args = typeof input.command === "string" ? ["-lc", input.command] : input.command.slice(1);
	let killed = false;
	const stdout = new BoundedTextBuffer();
	const stderr = new BoundedTextBuffer();

	return new Promise((resolvePromise, reject) => {
		const child = spawn(command, args, { cwd: input.cwd, env: input.env, shell: false });
		let timeout: ReturnType<typeof setTimeout> | undefined;
		let isSettled = false;
		const cleanup = () => {
			if (timeout) clearTimeout(timeout);
			input.signal?.removeEventListener("abort", killChild);
		};
		const finish = (result: SpawnCommandResult) => {
			if (isSettled) return;
			isSettled = true;
			cleanup();
			void closeStreams(input.stdoutStream, input.stderrStream).then(() => resolvePromise(result), reject);
		};
		const fail = (error: Error) => {
			if (isSettled) return;
			isSettled = true;
			cleanup();
			void closeStreams(input.stdoutStream, input.stderrStream).then(() => reject(error), reject);
		};
		const killChild = () => {
			killed = true;
			child.kill("SIGTERM");
			setTimeout(() => {
				if (!child.killed) child.kill("SIGKILL");
			}, 5_000).unref?.();
		};

		if (input.timeoutMs !== undefined) timeout = setTimeout(killChild, input.timeoutMs);
		if (input.signal?.aborted) killChild();
		input.signal?.addEventListener("abort", killChild, { once: true });

		child.stdout?.on("data", (chunk) => {
			const text = chunk.toString();
			stdout.append(text);
			input.stdoutStream.write(text);
		});
		child.stderr?.on("data", (chunk) => {
			const text = chunk.toString();
			stderr.append(text);
			input.stderrStream.write(text);
		});
		child.on("error", fail);
		child.on("close", (code) => finish({ exitCode: code, stdoutTail: stdout.value(), stderrTail: stderr.value(), killed }));
	});
}

function commandLog(label: string, stream: "stdout" | "stderr"): NornLogRef {
	return { id: `commands/${safeFileName(label)}.${stream}` };
}

class BoundedTextBuffer {
	private text = "";

	constructor(private readonly maxChars = 128_000) {}

	append(value: string): void {
		this.text += value;
		if (this.text.length > this.maxChars) this.text = this.text.slice(this.text.length - this.maxChars);
	}

	value(): string {
		return this.text;
	}
}

async function closeStreams(...streams: WriteStream[]): Promise<void> {
	await Promise.all(streams.map((stream) => new Promise<void>((resolvePromise, reject) => {
		stream.on("error", reject);
		stream.end(resolvePromise);
	})));
}
