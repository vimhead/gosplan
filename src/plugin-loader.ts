import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti";
import { z } from "zod";
import { isWorkflowPlugin, type PalantirWorkflowPlugin } from "./api.ts";
import { isNodeError } from "./internal/errors.ts";
import { PalantirMemoryWorkflowState } from "./internal/state-store.ts";
import { PalantirWorkflowRegistry, type PalantirRegisteredWorkflow } from "./internal/workflow-registry.ts";
import { resolveSeerModeConfig, type PalantirResolvedSeerModeConfig } from "./seer/index.ts";

const PALANTIR_CONFIG_FILE_NAME = "palantir.json";
const seerModeConfigSchema = z.object({
	writableRoots: z.array(z.string().min(1)).min(1),
});
const palantirConfigSchema = z.object({
	plugins: z.array(z.string().min(1)).default([]),
	includes: z.array(z.string().min(1)).default([]),
	seerMode: seerModeConfigSchema.optional(),
});

type PalantirConfig = z.output<typeof palantirConfigSchema>;

type PalantirConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: PalantirConfig;
};

export type PalantirProject = {
	readonly cwd: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly config: PalantirConfig;
	readonly configFiles: readonly PalantirConfigFile[];
	readonly seerMode?: PalantirResolvedSeerModeConfig;
};

export type PalantirLoadedProject = PalantirProject & {
	readonly plugins: readonly PalantirWorkflowPlugin[];
	readonly registry: PalantirWorkflowRegistry;
	readonly workflows: readonly PalantirRegisteredWorkflow[];
	readonly state: PalantirMemoryWorkflowState;
};

export async function loadPalantirProject(cwd: string): Promise<PalantirLoadedProject> {
	const project = await findPalantirProject(cwd);
	const plugins = await loadWorkflowPlugins(project);
	const registry = new PalantirWorkflowRegistry();
	const state = new PalantirMemoryWorkflowState();
	for (const plugin of plugins) {
		const implementation = typeof plugin.implementation === "function"
			? plugin.implementation({ cwd: project.cwd, state })
			: plugin.implementation;
		for (const [key, workflow] of Object.entries(plugin.manifest.workflows)) {
			const workflowImplementation = implementation.workflows[key];
			if (!workflowImplementation) throw new Error(`Missing implementation for workflow ${plugin.manifest.id}.${key}`);
			registry.register(workflow, workflowImplementation);
		}
	}
	return { ...project, plugins, registry, workflows: registry.launchableEntries(), state };
}

export async function findPalantirProject(cwd: string): Promise<PalantirProject> {
	const configPath = await findNearestPalantirConfig(cwd);
	const rootConfig = await readPalantirConfigFile(configPath);
	const configFiles = await loadIncludedPalantirConfigFiles(rootConfig, new Set());
	return {
		cwd: resolve(cwd),
		configPath: rootConfig.path,
		configRoot: rootConfig.root,
		config: rootConfig.config,
		configFiles,
		seerMode: resolveSeerModeConfig({ configPath: rootConfig.path, configRoot: rootConfig.root, seerMode: rootConfig.config.seerMode }),
	};
}

async function findNearestPalantirConfig(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		const configPath = join(current, PALANTIR_CONFIG_FILE_NAME);
		try {
			await access(configPath);
			return configPath;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) throw new Error(`Could not find ${PALANTIR_CONFIG_FILE_NAME} from ${cwd}`);
		current = parent;
	}
}

async function loadIncludedPalantirConfigFiles(configFile: PalantirConfigFile, visitedPaths: Set<string>): Promise<PalantirConfigFile[]> {
	if (visitedPaths.has(configFile.path)) return [];
	visitedPaths.add(configFile.path);
	const includedConfigFiles = await Promise.all(configFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(configFile.root, includePath);
		return Promise.all(configPaths.map(readPalantirConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadIncludedPalantirConfigFiles(includedConfigFile, visitedPaths)));
	return [configFile, ...descendants.flat()];
}

async function readPalantirConfigFile(path: string): Promise<PalantirConfigFile> {
	const config = palantirConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
	return { path, root: dirname(path), config };
}

async function loadWorkflowPlugins(project: PalantirProject): Promise<PalantirWorkflowPlugin[]> {
	const plugins: PalantirWorkflowPlugin[] = [];
	for (const configFile of project.configFiles) {
		const jiti = createJiti(pathToFileURL(configFile.path).href, { moduleCache: false });
		for (const pluginPath of configFile.config.plugins) {
			const resolvedPluginPath = resolveConfigPath(configFile.root, pluginPath);
			const module = await jiti.import(pathToFileURL(resolvedPluginPath).href) as { default?: unknown };
			if (!isWorkflowPlugin(module.default)) throw new Error(`Palantir plugin must be the default export: ${resolvedPluginPath}`);
			plugins.push(module.default);
		}
	}
	return plugins;
}

async function expandIncludePath(configRoot: string, includePath: string): Promise<string[]> {
	const resolvedIncludePath = resolveConfigPath(configRoot, includePath);
	if (!hasGlobSegment(includePath)) return [resolvedIncludePath];
	return expandGlobSegments(isAbsolute(includePath) ? sep : configRoot, splitPathSegments(includePath));
}

async function expandGlobSegments(root: string, segments: readonly string[]): Promise<string[]> {
	if (segments.length === 0) return [root];
	const [segment, ...remainingSegments] = segments;
	if (segment === "*") {
		const entries = await readdir(root, { withFileTypes: true });
		const expanded = await Promise.all(entries
			.filter((entry) => entry.isDirectory())
			.sort((left, right) => left.name.localeCompare(right.name))
			.map((entry) => expandGlobSegments(join(root, entry.name), remainingSegments)));
		return expanded.flat();
	}
	return expandGlobSegments(join(root, segment), remainingSegments);
}

function resolveConfigPath(configRoot: string, path: string): string {
	if (path.length === 0) throw new Error("Palantir path must not be empty");
	return isAbsolute(path) ? path : resolve(configRoot, path);
}

function hasGlobSegment(path: string): boolean {
	return splitPathSegments(path).includes("*");
}

function splitPathSegments(path: string): string[] {
	return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}
