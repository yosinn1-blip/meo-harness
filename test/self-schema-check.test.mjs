import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  REQUIRED_SELF_COLUMNS,
  checkSelfSchema,
  parseWranglerRows,
} from "../scripts/check-self-schema.mjs";

// The Worker reads notification_jobs.last_attempt_at (0006) in every notify
// slot; deploying it before 0006 is applied stops all LINE digests.
test("npm run deploy first checks that production D1 has the 0006 column", () => {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
  assert.equal(pkg.scripts.predeploy, "node scripts/check-self-schema.mjs");
  assert.deepEqual(REQUIRED_SELF_COLUMNS, { notification_jobs: ["last_attempt_at"] });
  const sql = readFileSync(new URL("../migrations/0006_notification_last_attempt.sql", import.meta.url), "utf8");
  for (const [table, columns] of Object.entries(REQUIRED_SELF_COLUMNS))
    for (const column of columns) assert.ok(sql.includes(`ALTER TABLE ${table} ADD COLUMN ${column} `));
});

test("the schema check fails when 0006 is not applied and passes when it is", async () => {
  const before = [{ name: "id" }, { name: "first_attempt_at" }, { name: "next_attempt_at" }];
  const asked = [];
  const missing = await checkSelfSchema({ run: async (table) => (asked.push(table), before) });
  assert.deepEqual(asked, ["notification_jobs"]);
  assert.deepEqual(missing, ["notification_jobs.last_attempt_at"]);
  assert.deepEqual(await checkSelfSchema({ run: async () => [...before, { name: "last_attempt_at" }] }), []);
});

test("a failed or unreadable check never passes", async () => {
  await assert.rejects(checkSelfSchema({ run: async () => { throw Error("wrangler failed"); } }));
  assert.throws(() => parseWranglerRows("not json"));
  assert.throws(() => parseWranglerRows(JSON.stringify([{ success: false, results: [] }])));
  assert.throws(() => parseWranglerRows(JSON.stringify([{ success: true, results: [] }])), /no rows/);
  assert.deepEqual(
    parseWranglerRows(JSON.stringify([{ success: true, results: [{ name: "id" }], meta: {} }])),
    [{ name: "id" }],
  );
});
