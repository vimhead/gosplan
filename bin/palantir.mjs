#!/usr/bin/env node
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, { moduleCache: false });
const cli = await jiti.import("../src/cli.ts");
await cli.main(process.argv.slice(2));
