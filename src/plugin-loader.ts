import { access, readFile, readdir } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";
import { createJiti } from "jiti/static";
import * as typeboxModule from "typebox";
import { z } from "zod";
import * as zodModule from "zod";
import * as nornApiModule from "./api.ts";
import * as nornModule from "./index.ts";
import * as nornSchemaModule from "./schema.ts";
import * as nornSeerModule from "./seer/index.ts";
import { isWorkflowPlugin, type NornJsonSchema, type NornProjectPluginInfo, type NornWorkflowPlugin, type NornWorkflowPluginInfo } from "./api.ts";
import { isNodeError } from "./internal/errors.ts";
import { NornMemoryWorkflowState } from "./internal/state-store.ts";
import { NornWorkflowRegistry, type NornRegisteredWorkflow } from "./internal/workflow-registry.ts";
import { schemaType, unwrapSchema } from "./schema.ts";
import { resolveSeerModeConfig, type NornResolvedSeerModeConfig } from "./seer/index.ts";

export const NORN_PROJECT_FILE_NAME = "norn.project.json";
export const NORN_CONFIG_FILE_NAME = "norn.json";

const seerModeConfigSchema = z.object({
	writableRoots: z.array(z.string().min(1)).min(1),
});
const nornConfigSchema = z.object({
	plugins: z.array(z.string().min(1)).default([]),
	includes: z.array(z.string().min(1)).default([]),
	config: z.record(z.string(), z.unknown()).default({}),
});
const nornProjectConfigSchema = z.object({
	version: z.literal(1).default(1),
	includes: z.array(z.string().min(1)).default([]),
	config: z.record(z.string(), z.unknown()).default({}),
	seerMode: seerModeConfigSchema.optional(),
});

type NornConfig = z.output<typeof nornConfigSchema> & { readonly seerMode?: never };
type NornProjectConfig = z.output<typeof nornProjectConfigSchema>;

type NornConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: NornConfig;
};

export type NornProject = {
	readonly cwd: string;
	readonly projectPath: string;
	readonly projectRoot: string;
	readonly configPath: string;
	readonly configRoot: string;
	readonly config: NornProjectConfig;
	readonly configFiles: readonly NornConfigFile[];
	readonly projectConfig: Record<string, unknown>;
	readonly seerMode?: NornResolvedSeerModeConfig;
};

export type NornLoadedProject = NornProject & {
	readonly plugins: readonly NornWorkflowPlugin[];
	readonly pluginInfos: readonly NornProjectPluginInfo[];
	readonly registry: NornWorkflowRegistry;
	readonly workflows: readonly NornRegisteredWorkflow[];
	readonly state: NornMemoryWorkflowState;
};

type LoadedNornWorkflowPlugin = {
	readonly plugin: NornWorkflowPlugin;
	readonly info: NornProjectPluginInfo;
};

export async function loadNornProject(cwd: string): Promise<NornLoadedProject> {
	const project = await findNornProject(cwd);
	const loadedPlugins = await loadWorkflowPlugins(project);
	const registry = new NornWorkflowRegistry();
	const state = new NornMemoryWorkflowState();
	for (const { plugin, info } of loadedPlugins) {
		const implementation = typeof plugin.implementation === "function"
			? plugin.implementation({ cwd: project.cwd, state })
			: plugin.implementation;
		for (const [key, workflow] of Object.entries(plugin.manifest.workflows)) {
			const workflowImplementation = implementation.workflows[key];
			if (!workflowImplementation) throw new Error(`Missing implementation for workflow ${plugin.manifest.id}.${key}`);
			registry.register(workflow, workflowImplementation, { plugin: workflowPluginInfo(info), configSchema: plugin.manifest.config, config: info.config });
		}
	}
	return { ...project, plugins: loadedPlugins.map(({ plugin }) => plugin), pluginInfos: loadedPlugins.map(({ info }) => info), registry, workflows: registry.launchableEntries(), state };
}

export async function findNornProject(cwd: string): Promise<NornProject> {
	const projectPath = await findNearestNornProject(cwd);
	const projectRootConfig = await readNornProjectConfigFile(projectPath);
	const configFiles = await loadIncludedNornConfigFiles(projectRootConfig, new Set());
	return {
		cwd: resolve(cwd),
		projectPath: projectRootConfig.path,
		projectRoot: projectRootConfig.root,
		configPath: projectRootConfig.path,
		configRoot: projectRootConfig.root,
		config: projectRootConfig.config,
		configFiles,
		projectConfig: mergeProjectConfig(configFiles),
		seerMode: resolveSeerModeConfig({ configPath: projectRootConfig.path, configRoot: projectRootConfig.root, seerMode: projectRootConfig.config.seerMode }),
	};
}

async function findNearestNornProject(cwd: string): Promise<string> {
	let current = resolve(cwd);
	while (true) {
		const projectPath = join(current, NORN_PROJECT_FILE_NAME);
		try {
			await access(projectPath);
			return projectPath;
		} catch (error) {
			if (!isNodeError(error) || error.code !== "ENOENT") throw error;
		}
		const parent = dirname(current);
		if (parent === current) throw new Error(`Could not find ${NORN_PROJECT_FILE_NAME} from ${cwd}`);
		current = parent;
	}
}

type NornProjectConfigFile = {
	readonly path: string;
	readonly root: string;
	readonly config: NornProjectConfig;
};

async function loadIncludedNornConfigFiles(projectFile: NornProjectConfigFile, visitedPaths: Set<string>): Promise<NornConfigFile[]> {
	const includedConfigFiles = await Promise.all(projectFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(projectFile.root, includePath);
		return Promise.all(configPaths.map(readNornConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadNornConfigTree(includedConfigFile, visitedPaths)));
	return [projectConfigFile(projectFile), ...descendants.flat()];
}

async function loadNornConfigTree(configFile: NornConfigFile, visitedPaths: Set<string>): Promise<NornConfigFile[]> {
	if (visitedPaths.has(configFile.path)) return [];
	visitedPaths.add(configFile.path);
	const includedConfigFiles = await Promise.all(configFile.config.includes.map(async (includePath) => {
		const configPaths = await expandIncludePath(configFile.root, includePath);
		return Promise.all(configPaths.map(readNornConfigFile));
	}));
	const descendants = await Promise.all(includedConfigFiles.flat().map((includedConfigFile) => loadNornConfigTree(includedConfigFile, visitedPaths)));
	return [configFile, ...descendants.flat()];
}

async function readNornProjectConfigFile(path: string): Promise<NornProjectConfigFile> {
	const config = nornProjectConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
	return { path, root: dirname(path), config };
}

async function readNornConfigFile(path: string): Promise<NornConfigFile> {
	const config = nornConfigSchema.parse(JSON.parse(await readFile(path, "utf8")));
	return { path, root: dirname(path), config };
}

function projectConfigFile(projectFile: NornProjectConfigFile): NornConfigFile {
	return {
		path: projectFile.path,
		root: projectFile.root,
		config: {
			plugins: [],
			includes: projectFile.config.includes,
			config: projectFile.config.config,
		},
	};
}

async function loadWorkflowPlugins(project: NornProject): Promise<LoadedNornWorkflowPlugin[]> {
	const plugins: LoadedNornWorkflowPlugin[] = [];
	const pluginIds = new Set<string>();
	for (const configFile of project.configFiles) {
		const jiti = createJiti(pathToFileURL(configFile.path).href, { moduleCache: false, virtualModules: nornWorkflowVirtualModules() });
		for (const pluginPath of configFile.config.plugins) {
			const resolvedPluginPath = resolveConfigPath(configFile.root, pluginPath);
			const module = await jiti.import(pathToFileURL(resolvedPluginPath).href) as { default?: unknown };
			if (!isWorkflowPlugin(module.default)) throw new Error(`Norn plugin must be the default export: ${resolvedPluginPath}`);
			if (pluginIds.has(module.default.manifest.id)) throw new Error(`Duplicate Norn plugin id: ${module.default.manifest.id}`);
			pluginIds.add(module.default.manifest.id);
			const configInput = project.projectConfig[module.default.manifest.id];
			if (!module.default.manifest.config && configInput !== undefined) throw new Error(`Norn config provided for plugin without config schema: ${module.default.manifest.id}`);
			const config = module.default.manifest.config ? module.default.manifest.config.parse(defaultConfigInput(module.default.manifest.config, configInput)) : undefined;
			plugins.push({
				plugin: module.default,
				info: {
					id: module.default.manifest.id,
					path: resolvedPluginPath,
					configPath: configFile.path,
					configSchema: module.default.manifest.config ? z.toJSONSchema(module.default.manifest.config, { io: "input" }) as NornJsonSchema : null,
					config,
				},
			});
		}
	}
	return plugins;
}

function workflowPluginInfo(info: NornProjectPluginInfo): NornWorkflowPluginInfo {
	return { id: info.id, path: info.path, configPath: info.configPath };
}

function nornWorkflowVirtualModules(): Record<string, unknown> {
	return {
		norn: nornModule,
		"norn/api": nornApiModule,
		"norn/schema": nornSchemaModule,
		"norn/seer": nornSeerModule,
		typebox: typeboxModule,
		zod: zodModule,
	};
}

function mergeProjectConfig(configFiles: readonly NornConfigFile[]): Record<string, unknown> {
	const [projectFile, ...reusableConfigFiles] = configFiles;
	let reusableConfig: Record<string, unknown> = {};
	for (const configFile of reusableConfigFiles) {
		reusableConfig = mergeReusableConfigObjects(reusableConfig, configFile.config.config, ["config"]);
	}
	return mergeProjectConfigObjects(reusableConfig, projectFile?.config.config ?? {});
}

function mergeReusableConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>, path: readonly string[]): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		result[key] = Object.prototype.hasOwnProperty.call(result, key)
			? mergeReusableConfigValue(result[key], overrideValue, [...path, key])
			: overrideValue;
	}
	return result;
}

function mergeReusableConfigValue(base: unknown, override: unknown, path: readonly string[]): unknown {
	if (isPlainObject(base) && isPlainObject(override)) return mergeReusableConfigObjects(base, override, path);
	if (JSON.stringify(base) === JSON.stringify(override)) return base;
	throw new Error(`Conflicting Norn reusable config at ${path.join(".")}`);
}

function mergeProjectConfigObjects(base: Record<string, unknown>, override: Record<string, unknown>): Record<string, unknown> {
	const result: Record<string, unknown> = { ...base };
	for (const [key, overrideValue] of Object.entries(override)) {
		result[key] = isPlainObject(result[key]) && isPlainObject(overrideValue)
			? mergeProjectConfigObjects(result[key], overrideValue)
			: overrideValue;
	}
	return result;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function defaultConfigInput(configSchema: z.ZodType, config: unknown): unknown {
	if (config !== undefined) return config;
	return schemaType(unwrapSchema(configSchema)) === "object" ? {} : undefined;
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
	if (path.length === 0) throw new Error("Norn path must not be empty");
	return isAbsolute(path) ? path : resolve(configRoot, path);
}

function hasGlobSegment(path: string): boolean {
	return splitPathSegments(path).includes("*");
}

function splitPathSegments(path: string): string[] {
	return path.split(/[\\/]+/).filter((segment) => segment.length > 0 && segment !== ".");
}
