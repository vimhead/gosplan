import { isAbsolute, relative, resolve, sep } from "node:path";

export type PalantirSeerModeConfig = {
	readonly writableRoots: readonly string[];
};

export type PalantirResolvedSeerModeConfig = {
	readonly configPath: string;
	readonly projectRoot: string;
	readonly writableRoots: readonly string[];
};

type ResolveSeerModeConfigInput = {
	readonly configPath: string;
	readonly configRoot: string;
	readonly seerMode: PalantirSeerModeConfig | undefined;
};

export function resolveSeerModeConfig(input: ResolveSeerModeConfigInput): PalantirResolvedSeerModeConfig | undefined {
	if (!input.seerMode) return undefined;
	if (input.seerMode.writableRoots.length === 0) throw new Error("Palantir seerMode.writableRoots must not be empty");
	const projectRoot = resolve(input.configRoot);
	const writableRoots = Array.from(new Set(input.seerMode.writableRoots.map((path) => resolveWritableRoot(projectRoot, path))));
	return { configPath: input.configPath, projectRoot, writableRoots };
}

export function assertSeerModeWritablePath(seerMode: PalantirResolvedSeerModeConfig, cwd: string, path: string): string {
	const resolvedPath = resolveSeerModePath(seerMode, cwd, path);
	if (!isSeerModeWritableResolvedPath(seerMode, resolvedPath)) {
		throw new Error(`Path is outside Palantir seerMode writable roots: ${path}`);
	}
	return resolvedPath;
}

export function isSeerModeWritablePath(seerMode: PalantirResolvedSeerModeConfig, cwd: string, path: string): boolean {
	return isSeerModeWritableResolvedPath(seerMode, resolveSeerModePath(seerMode, cwd, path));
}

function resolveWritableRoot(projectRoot: string, path: string): string {
	if (path.length === 0) throw new Error("Palantir seerMode writable root must not be empty");
	const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(projectRoot, path);
	if (!isInsideOrEqual(projectRoot, resolvedPath)) throw new Error(`Palantir seerMode writable root escapes project root: ${path}`);
	return resolvedPath;
}

function resolveSeerModePath(seerMode: PalantirResolvedSeerModeConfig, cwd: string, path: string): string {
	if (path.length === 0) throw new Error("Palantir seerMode path must not be empty");
	const resolvedCwd = resolve(cwd);
	if (!isInsideOrEqual(seerMode.projectRoot, resolvedCwd)) throw new Error(`Palantir seerMode cwd escapes project root: ${cwd}`);
	const resolvedPath = isAbsolute(path) ? resolve(path) : resolve(resolvedCwd, path);
	if (!isInsideOrEqual(seerMode.projectRoot, resolvedPath)) return resolvedPath;
	return resolvedPath;
}

function isSeerModeWritableResolvedPath(seerMode: PalantirResolvedSeerModeConfig, path: string): boolean {
	return seerMode.writableRoots.some((root) => isInsideOrEqual(root, path));
}

function isInsideOrEqual(root: string, path: string): boolean {
	const pathFromRoot = relative(root, path);
	return pathFromRoot === "" || (!pathFromRoot.startsWith(`..${sep}`) && pathFromRoot !== ".." && !isAbsolute(pathFromRoot));
}
