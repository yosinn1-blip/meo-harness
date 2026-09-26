import { startTestApp } from "../test/support/self-browser.mjs";
const app = await startTestApp();
console.log("Local fixture preview:", app.baseURL);
console.log(
  "Fixture controls require a per-run key; use npm run test:e2e for full flows.",
);
process.on("SIGINT", async () => {
  await app.stop();
  process.exit(0);
});
