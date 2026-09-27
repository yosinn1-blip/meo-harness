# MEO Harness launch completion plan

> **For agentic workers:** Use `superpowers:executing-plans` inline. Independent agents are read-only reviewers, not parallel editors of this checkout.

**Goal:** Complete the previously approved self-service flow, with verified live registration, LINE confirmation, safe stop/disconnect and a bounded public launch.

**Spec:** `/Users/yoshiki/dev/meo-harness/docs/superpowers/specs/2026-09-27-self-service-onboarding-design.md`.

**Architecture:** Preserve the existing Worker, D1, shared LINE service and explicit per-review approval. Fix release blockers without adding a second implementation or bypassing authentication. Reuse the existing worktree and integrate with Git only.

**Constraints:** No unauthorized salon connection; no fabricated public reviews; no paid upgrade; no secret in logs. Production changes, actual messages and public launch require their precise scope to be confirmed. Google brand publication is now confirmed live, not pending.

## Execution ledger

- Starting commit: `de73999`. Main and existing worktree clean. User explicitly requests continuation to completion.
- External delegation: both MEO paths are absent from the Z.ai safety list. Do not expand the list; implement inline. Read-only independent reviews cover D1 limits and GBP storage constraints.
- Ruling: Reuse the approved design/plan rather than restart product design. Any change to live side-effect permissions remains a separate confirmation boundary.
- Ruling: For a real owner trial, first select the owner store in the existing connect-only pilot; only after explicit approval, switch to registration-OFF and processing-ON with bounded budgets. Do not add an authentication bypass or fabricate a test GBP location.

## Tasks

- [ ] Reproduce and fix the legacy paused-store processing gap. Test scheduler, buffered notifications and direct ingestion with fake external providers; preserve active/unspecified legacy compatibility. This is a prerequisite to an approved, reversible trial using the owner's already-connected store.
- [ ] Bound self-service scheduled work under the Free invocation limits, including cleanup, provider failures, AI-save failures, pending notifications and ambiguous replies. Test progress/fairness and avoid counting SQL statements as equivalent to binding calls without evidence.
- [ ] Remove unbounded cached GBP content/identifiers; align cache refresh/expiry, operational usage counters and backup-safe recovery with documented retention. Add time-boundary and re-registration regression tests before implementation.
- [ ] Verify actual Google publication, provider capacity/data controls and current production logging. Update accurate privacy/operations text; do not claim settings not observed.
- [ ] Run all unit/runtime/browser tests at a fixed commit and bundle hash, independent whole-diff review, then prepare an explicit production/trial approval covering target, limits, real messages and rollback.
- [ ] After approval, execute the real owner flow, observe LINE delivery/PIN, zero-review success, stop and disconnect with credentials removed. Preserve/reinstate the legacy reservation as appropriate; do not automatically post a public review.
- [ ] Evaluate release gates, request the exact bounded general-launch approval, then verify the published entry link and new-user flow. Article publication is distinct and must accurately describe the final limits.

## Verification boundaries

Mock-provider E2E is not real provider success. Google brand publication is not app registration enabled. A submitted LINE API request is not user receipt. New code being committed is not production deployed. Each task records evidence and the next unresolved gate rather than saying the full service is complete early.
