import { test } from "node:test";
import assert from "node:assert/strict";
import { withD1 } from "../support/self-runtime.mjs";
test("local D1 isolated from production bindings", async (t) => {
  const { db } = await withD1(t);
  assert.equal((await db.prepare("SELECT 1 AS n").first()).n, 1);
});
