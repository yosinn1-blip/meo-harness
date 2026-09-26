import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";
export function evaluateReleaseGate(evidence = {}) {
  const e = evidence && typeof evidence === "object" ? evidence : {};
  const required = {
    OAUTH_VERIFICATION: e.oauthVerified === true,
    QUOTA_LIMITS: e.quotaChecked === true,
    LOCAL_TESTS: e.localTests === true,
    BROWSER_STUB_E2E: e.browserStubE2E === true,
    LIVE_CONNECTION: e.liveConnection === true,
    STOP_FLOW: e.liveStopVerified === true,
    PRIVACY: e.privacyReviewed === true,
    APPROVAL: e.approvedRelease === true,
  };
  const blocking = Object.keys(required).filter((key) => !required[key]);
  return { ready: blocking.length === 0, blocking };
}
if (
  process.argv[1] &&
  import.meta.url === pathToFileURL(process.argv[1]).href
) {
  let result;
  try {
    const index = process.argv.indexOf("--evidence");
    if (index === -1 || !process.argv[index + 1]) throw new Error("missing");
    result = evaluateReleaseGate(
      JSON.parse(await readFile(process.argv[index + 1], "utf8")),
    );
  } catch {
    result = { ready: false, blocking: ["EVIDENCE_UNAVAILABLE"] };
  }
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
  process.exitCode = result.ready ? 0 : 1;
}
