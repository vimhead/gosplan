import { PALANTIR_GENERATED_BUILD_INFO } from "./generated-build-info.ts";

export type PalantirBuildInfo = PalantirUnknownBuildInfo | PalantirNpmGitGlobalBuildInfo | PalantirGithubReleaseBinaryBuildInfo;

export type PalantirUnknownBuildInfo = {
	readonly kind: "unknown";
	readonly version: string;
	readonly commit: string | null;
	readonly upgrade: {
		readonly supported: false;
		readonly reason: string;
	};
};

export type PalantirNpmGitGlobalBuildInfo = {
	readonly kind: "npm-git-global";
	readonly version: string;
	readonly commit: string | null;
	readonly repository: string;
	readonly packageSpec: string;
	readonly upgradeCommand: readonly string[];
};

export type PalantirGithubReleaseBinaryBuildInfo = {
	readonly kind: "github-release-binary";
	readonly version: string;
	readonly commit: string | null;
	readonly repository: string;
	readonly releaseTag: string;
	readonly assetName: string;
	readonly checksumAssetName: string;
};

export const PALANTIR_BUILD_INFO: PalantirBuildInfo = PALANTIR_GENERATED_BUILD_INFO;
