# Night Agent

## Objective

Audit and improve code quality, security, dependencies, reliability, design and UX, and documentation through small, reviewable changes. Prioritize fixes that reduce real user or operational risk over feature invention and cosmetic churn.

## Priorities

1. Fix security vulnerabilities, unsafe data handling, authorization mistakes, injection risks, and insecure defaults.
2. Fix reliability and correctness problems, including failures, race conditions, data-loss risks, and poor error handling.
3. Upgrade dependencies when doing so addresses vulnerabilities, incompatibility, or meaningful maintenance risk.
4. Improve important user flows that are confusing, inaccessible, error-prone, slow, or unnecessarily difficult.
5. Fix code quality issues that materially hurt maintainability.
6. Correct documentation that is missing, misleading, or inconsistent with current behavior.

## Constraints

- Base findings on concrete repository evidence; do not invent hypothetical vulnerabilities or product requirements.
- Preserve established architecture, design language, and public behavior unless a verified fix requires a change.
- Keep dependency upgrades focused, inspect migration requirements, update lockfiles, and avoid unrelated major upgrades.
- UX changes must improve a specific flow and preserve accessibility and responsive behavior.
- Do not perform broad refactors, formatting sweeps, speculative optimization, or test weakening.
- Process as many eligible low-risk fixes as practical, with independent verification and a separate commit for every fix.
- Run the narrowest relevant checks, then broader checks when practical.
- Keep product-fix commits free of `.night-agent/` files; commit memory and reports separately on `night-agent`. Never push.

## Project Commands

Replace these examples with the repository's actual commands:

- Tests: `npm test`
- Type check: `npm run typecheck`
- Lint: `npm run lint`
- Build: `npm run build`
- Dependency audit: `npm audit`

## Project Context

Describe primary users, critical user flows, sensitive data, deployment constraints, supported platforms, and prohibited areas.

## Approved Work

Move vetted finding IDs here before the next run. Include scope, acceptance criteria, and any conditions.

## Safe Auto-fix Queue

The agent adds only small, reversible, independently verifiable work that preserves intended behavior.

## Needs Your Decision

The agent records higher-risk and subjective proposals here. Every item should include a stable ID, evidence, impact, options, recommendation, risk, and verification plan.

## Rejected Or Deferred

Move declined items here with a short reason so the agent does not repeatedly suggest them.

## Decisions

Record durable technical decisions and their rationale.

## Audit Findings

### Security

Record verified security findings, severity, evidence, and likely remediation.

### Reliability

Record reproducible correctness, resilience, performance, and error-handling findings.

### Dependencies

Record outdated or vulnerable packages only when an upgrade has a concrete benefit.

### Design And UX

Record the affected user flow, observed friction, accessibility or responsive impact, and acceptance criteria.

### Code Quality

Record maintainability problems with concrete impact.

### Documentation

Record specific gaps or contradictions and the source of truth.

## Failed Approaches

Record approaches that should not be repeated and why.

## Completed Work

Keep a compact list of outcomes and commit hashes. Detailed chronology belongs in `.night-agent/reports/`.
