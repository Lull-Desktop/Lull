#!/usr/bin/env node
/**
 * lull-ext: the Lull extension development CLI.
 *
 * Under npx the working directory is temporary, so every path is derived from the
 * package root or from explicit arguments; never assume a repo checkout. Subcommand
 * implementations live in ../lib/*.mjs.
 */
import { main } from "../lib/cli.mjs";

main(process.argv.slice(2)).catch((error) => {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`[error] ${message}\n`);
  if (process.env.LULL_EXT_DEBUG && error instanceof Error && error.stack) {
    process.stderr.write(`${error.stack}\n`);
  }
  process.exit(Number.isInteger(error?.exitCode) ? error.exitCode : 1);
});
