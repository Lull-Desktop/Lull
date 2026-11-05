import { bundleGameEntry } from "../../../scripts/lib/game-demo-build.mjs";

export default async function build({ sourceDir, distDir }) {
  await bundleGameEntry({
    sourceDir,
    distDir,
    entry: "src/replica.ts",
    outfile: "replica/main.js",
  });
}
