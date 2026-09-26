import { build } from "esbuild";
import { mkdir } from "node:fs/promises";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";
export async function buildWorker() {
  await mkdir("output/self-service", { recursive: true });
  const outfile = resolve("output/self-service/worker.mjs");
  await build({
    entryPoints: ["worker/index.mjs"],
    outfile,
    bundle: true,
    format: "esm",
    platform: "neutral",
    target: "es2022",
    loader: { ".html": "text", ".css": "text", ".txt": "text", ".md": "text" },
  });
  return pathToFileURL(outfile).href;
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(resolve(process.argv[1])).href
)
  console.log(await buildWorker());
