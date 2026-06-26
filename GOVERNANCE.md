# Governance

This document describes how the SovEcom project is governed and how decisions are made. Governance scales with the project; this is **Stage 1**.

## Current Stage: Founder-Led (Stage 1)

SovEcom is currently **founder-led**. We say this plainly rather than pretending a larger structure exists:

- The founder acts as **BDFL** (Benevolent Dictator For Life) and is solely responsible for project direction.
- **All merges require the founder's approval.**
- Major decisions are recorded in the project's Critical Decisions Log (ADR-style) so the reasoning trail is preserved.
- The roadmap is public.
- Anyone may submit an RFC for a major proposal; the founder decides.

> Community governance comes as the community grows. The staged plan below is how we get there.

## Governance Roadmap

| Stage | When | Structure |
|---|---|---|
| **1 — Founder-Led** | Year 1 (now) | BDFL; all merges founder-approved; decisions logged |
| **2 — Core Maintainer Team** | Year 1–2 | +2 maintainers with merge rights; 7-day PR review commitment; monthly sync |
| **3 — Technical Steering Committee** | Year 2–3 | 3–5 voting members (founder + paid contributors + agency users); TSC decides technical direction, founder retains veto on commercial/business decisions |
| **4 — Foundation Arrangement** | Year 4+ | Only if sustained critical mass — consider transferring trademark/assets to a software foundation |

We do not pursue later stages prematurely. Foundations and committees add overhead small projects cannot afford.

## RFC Process

Non-trivial changes go through an RFC (Request For Comments).

**Requires an RFC:**
- New module API additions
- Breaking changes to the API
- New core features / changes to the v1 spec
- Removing features
- Changes to the security model
- Changes to license or governance

**Does NOT require an RFC:**
- Bug fixes
- Documentation improvements
- Internal refactoring that does not change behavior
- New modules in the official org

**Workflow:**
1. Open a GitHub Discussion in the **RFC** category using the template.
2. Title format: `RFC-NNNN: Short Title`.
3. Minimum 14-day comment period (longer for big changes).
4. The maintainer (or, later, the TSC) makes the decision.
5. The decision is recorded in the RFC thread with rationale.
6. If accepted, the RFC becomes the spec; the implementation PR references it.

## Decision Logging

Every major decision is captured as an Architecture Decision Record (ADR). When we change our mind, we add a **new** ADR that supersedes the old one — we never silently rewrite history. This preserves the reasoning trail.

## Contributor License Agreement

Every external contributor must sign a CLA before any PR is merged. This is non-negotiable — it is what allows us to offer commercial licenses while keeping the core AGPL. See [CONTRIBUTING.md](./CONTRIBUTING.md).

## Code of Conduct

Participation is governed by our [Code of Conduct](./CODE_OF_CONDUCT.md) (Contributor Covenant 2.1). Reports go to `conduct@sovecom.io`.

## Continuity (Bus Factor)

In Stage 1 the bus factor is 1. This is an acknowledged risk with active mitigations (documentation, planned co-maintainer recruitment, a designated successor maintainer, trademark held in the commercial entity). See [MAINTAINERS.md](./MAINTAINERS.md) for the designated successor.
