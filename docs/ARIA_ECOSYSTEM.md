# ARIA Agent Ecosystem — Advanced Orchestration (LocalAI)

## 1. Vision & Architecture

The ARIA (Admin Runtime Intelligence Assistant) ecosystem is an **Event-Driven Orchestration** model, now fully integrated into the LocalAI extension. It enables high-precision interventions using 100% local models while maintaining a sophisticated multi-agent strategy.

## 2. Specialized Agent Catalog

| Role | Title | Expertise | Step Budget |
| :--- | :--- | :--- | :--- |
| **Architect** | `aria-orchestrator` | Strategy, delegation, and final validation. | 50 rounds |
| **UI/UX** | `rtl-ui-auditor` | Arabic support (RTL), Tailwind, Premium aesthetics. | 30 rounds |
| **Database** | `database-expert` | PostgreSQL, Supabase, RLS, and migration design. | 35 rounds |
| **Security** | `security-sentinel` | OWASP auditing, RLS validation, and secrets scanning. | 30 rounds |
| **Cleanup** | `refactoring-expert` | Technical debt, Clean Code, and SOLID patterns. | 80 rounds |
| **Audit** | `performance-monitor` | Core Web Vitals, performance logs, and error tracking. | 30 rounds |
| **Standard** | `onboarding-expert` | Project conventions and documentation integrity. | 20 rounds |

## 3. Local Operational Protocols

Despite being local-first, the ARIA ecosystem enforces strict production-grade rules:

### A. Mandatory Verdicts

Security and Verification agents MUST conclude their tasks with a clear status:

- `[VERDICT: PASS]` — Clean bill of health.
- `[VERDICT: FAIL]` — Critical blockers or vulnerabilities detected.
- `[VERDICT: PARTIAL]` — Safe with minor follow-up items.

### B. Dynamic Step Budgets

Step limits are now task-aware to ensure complex local inferences can complete their goal:

- **Refactoring:** Up to **80 rounds**.
- **Orchestration:** Up to **50 rounds**.
- **Specialized Audits:** Up to **30-35 rounds**.
- **General Tasks:** Defaulting to your configured round count (default 15).

### C. Premium UI Grounding

Agents are grounded in the CloudZIR "Premium" design system:

- **Style:** Glassmorphism, smooth gradients (HSL), and fluid transitions.
- **i18n:** Full mirrored layout support for Arabic (RTL).

## 4. Local Reference

Internal agents reference the [lib/aria_blueprint.md](../lib/aria_blueprint.md) for real-time grounding in these rules.
