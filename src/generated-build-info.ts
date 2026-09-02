import type { PalantirBuildInfo } from "./build-info.ts";

export const PALANTIR_GENERATED_BUILD_INFO = {
	kind: "unknown",
	version: "0.1.0",
	commit: null,
	upgrade: {
		supported: false,
		reason: "This Palantir build does not include upgrade metadata.",
	},
} as const satisfies PalantirBuildInfo;
