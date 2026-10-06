// Runs before `npm run deploy` (predeploy). The Worker reads columns that later
// migrations add (0006: notification_jobs.last_attempt_at) in every notify
// slot, so it must not go live before they exist in production D1. Apply only
// the missing migration file first (never re-run 0001-0005), then deploy.
// Read-only: one PRAGMA table_info per table. Extra args (e.g. `--local
// --persist-to dir`) replace `--remote` for local checks.
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

export const SELF_DB_NAME = "meo-harness-self-service";
export const REQUIRED_SELF_COLUMNS = Object.freeze({
  notification_jobs: ["last_attempt_at"],
});

export function parseWranglerRows(stdout) {
  const parsed = JSON.parse(stdout);
  const result = Array.isArray(parsed) ? parsed[0] : parsed;
  if (!result || result.success !== true || !Array.isArray(result.results))
    throw new Error("D1_QUERY_FAILED");
  // PRAGMA table_info returns no rows for a missing table: never a pass.
  if (!result.results.length) throw new Error("D1_TABLE_INFO: no rows");
  return result.results;
}

export async function checkSelfSchema({ run }) {
  const missing = [];
  for (const [table, columns] of Object.entries(REQUIRED_SELF_COLUMNS)) {
    const names = new Set((await run(table)).map((row) => row.name));
    for (const column of columns)
      if (!names.has(column)) missing.push(table + "." + column);
  }
  return missing;
}

export function wranglerRunner(target = ["--remote"]) {
  const exec = promisify(execFile);
  return async (table) => {
    const { stdout } = await exec(
      "npx",
      [
        "--no-install",
        "wrangler",
        "d1",
        "execute",
        SELF_DB_NAME,
        ...target,
        "--json",
        "--command",
        `PRAGMA table_info(${table})`,
      ],
      { maxBuffer: 1 << 20 },
    );
    return parseWranglerRows(stdout);
  };
}

if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  const extra = process.argv.slice(2);
  try {
    const missing = await checkSelfSchema({
      run: wranglerRunner(extra.length ? extra : ["--remote"]),
    });
    if (missing.length) {
      console.error(
        "SELF_SCHEMA_MISSING: " +
          missing.join(", ") +
          " — apply migrations/0006_notification_last_attempt.sql to D1 first (only that file), then deploy.",
      );
      process.exitCode = 1;
    } else console.log("SELF_SCHEMA_OK");
  } catch (e) {
    console.error("SELF_SCHEMA_UNCHECKED: " + (e?.message ?? "error"));
    process.exitCode = 1;
  }
}
