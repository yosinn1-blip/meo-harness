# LINE automatic PIN implementation plan

> For agentic workers: execute this plan inline using executing-plans/TDD and one fresh whole-branch reviewer.

**Goal:** On a valid LINE registration-code message, send a session-bound confirmation PIN so the owner can read it before returning to the original browser. Keep manual recovery, ownership verification and explicit activation.

**Architecture:** Keep the existing signed webhook and push-budget sender. Add an opt-in automatic path and a D1 per-link delivery record with conditional claims. PIN remains hashed, bound to store generation and browser session, and is verified by the existing browser endpoint. No new external service or dependency.

**Tech Stack:** Existing JS Workers, D1/SQLite, Web Crypto, Node/Miniflare, Playwright.

**Spec:** `/Users/yoshiki/Documents/Codex/2026-10-01/task-4/output/meo-onboarding-ui-20261001/NEXT-DESIGN.md` (local artifact at task-4/output; authoritative authorization is the 20:10 delegated user request). Changes below implement the safety conditions from that proposal.

## Global constraints
- Base dd89727; keep main173aceb and cleanup d7d8699 unchanged. No main merge, push, PR, deploy, live Google/LINE, credentials or charges.
- Reuse existing node_modules; no dependency copies into Documents.
- Google consent, store selection, same-browser PIN verification and terms activation stay mandatory.
- Registration code 15min, PIN 5min/max5 attempts, sends max1/min and3/day, conservative shared push reservations unchanged.
- Opt-in SELF_LINE_AUTO_PIN_ENABLED flag defaults off. Deploy requires migration0004 then explicit flag approval; flag off is the primary behavioral rollback.
- Sending occurs only after valid single-use code, private LINE source, current generation and a live matching owner/browser session. Do not expose PIN/userId/hash/retry keys in status.
- D1 claim guards before external dispatch; no automatic retries of uncertain sends. Explicit manual retry keeps limits and replaces old PIN atomically.
- Bound automatic external I/O to20s within existing waitUntil lifetime. No new queue/cron/binding.

## Review focus
- Duplicate code delivery or manual/automatic concurrency must dispatch at most one in-flight push.
- Reissue/logout/session expiry/disconnect while quota calls run must cancel dispatch and preserve the newer generation's record.
- Accepted LINE API response is not proof of device delivery; uncertain sends retain PIN validity and budget use without auto replay.
- Reload/back cannot send or pretend an old PIN was sent to a new destination.
- New migration must cascade with existing link deletion, preserve old Worker inserts and support rollback with schema left in place.

### Task1: safe sender and delivery record
Files: migrations/0004_line_check_delivery.sql; worker/self-service/line-link.mjs; config.mjs; new line-check-delivery.mjs; test/self-runtime/line-auto-pin.test.mjs.
Interfaces: consumeLineCode(ctx,event) remains accepted-link handler; sendLineCheck(ctx,actor) remains browser recovery. readLineCheckStatus(ctx,store,sessionHash) returns only state/code/pinAvailable/expiresAt/retryAfterMs.
- [x] Write runtime tests with real D1 for valid auto send, duplicate/concurrent events, mismatched/expired browser, quotas, uncertainty, concurrent manual, reissue/disconnect and old-PIN refusal.
- [x] Run tests RED: valid code currently emits no push.
- [x] Implement per-link delivery row, atomic lock/claim, crypto PIN, shared limits and budget sender; use conditional SQL before PIN replacement and before dispatch. Track preparing/sending/sent/uncertain/held/failed with no PIN plaintext. Auto claims cannot replace any existing delivery record; manual claims can recover inactive/expired leases only.
- [x] Run new and existing runtime tests GREEN. Test deletes/cascade and previous six-column line_checks insertion for rollback compatibility.
- [x] Commit the independently tested sender/backend.

### Task2: status, UI and real webhook/browser fixtures
Files: status.mjs; ui/app.js.txt; test/support/self-browser.mjs; test/e2e/self-service.spec.mjs; docs/quickstart.md; FAQ/setup help as needed.
- [x] Write browser RED showing fixture code→automatic PIN→same browser verification, with no /line/test POST or activation without terms.
- [x] Project server delivery state into the same browser's UI. Input has the real current PIN expiry; preparing/sending polls read-only. Manual resend is recovery, clear errors/pending lease and wrong-browser recovery. Remove pinSent's misleading local-success basis.
- [x] Preserve flag-off manual flow; add true/false fixture scenarios and failure/uncertainty controls. Test reload/back, double click, expired PIN, different notification owner, held/unknown send and manual recovery.
- [x] Run all unit/runtime/browser/build and inspect mobile320/375 and PC1280 images. Compare standard operation count and browser↔LINE visits with dd89727 evidence.
- [x] Commit tested UI/status/docs.

### Task3: review and publish-ready local deliverables
- [ ] Fresh reviewer checks the whole diff from dd89727, plan/safety requirements and failure modes. Fix significant findings with RED→GREEN/full required suites.
- [ ] Separate patch/commit from dd89727; list migration/flag/live smoke-test approval, expected shared-budget impact and rollback.
- [ ] Adjust the flyer in a separate clearly unpublished draft folder if old manual PIN instruction differs. Keep current flyer/Library v2 untouched. Render/QR/text checks with existing tools.
- [ ] Report completed local artifacts to parent; coordinate note-write window with iCloud child via parent, then reread/append/readback notes.
