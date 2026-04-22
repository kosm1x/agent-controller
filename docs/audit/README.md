# Audit reports — 30-day hardening window

> **Window**: 2026-04-22 → 2026-05-22
> **Baseline**: `../benchmarks/2026-04-22-baseline.md`
> **Methodology**: `../planning/stabilization/full-system-audit.md`
> **Plan**: `../planning/stabilization/30d-hardening-plan.md`

## Dimensions

| #   | Dimension    | Report                       | Status     | Double-audit |
| --- | ------------ | ---------------------------- | ---------- | ------------ |
| 1   | Efficiency   | `2026-04-22-efficiency.md`   | **closed** | no           |
| 2   | Speed        | `2026-04-22-speed.md`        | **closed** | no           |
| 3   | Security     | `2026-04-22-security.md`     | **closed** | **yes**      |
| 4   | Resilience   | `2026-04-22-resilience.md`   | **closed** | **yes**      |
| 5   | Tool scoping | `YYYY-MM-DD-tool-scoping.md` | pending    | no           |

## Convention

- Every finding: `file:line` cite or SQL result or journalctl log line. No speculation.
- Every finding: **Fix** (with PR/commit link) or **Defer** (with trigger to promote).
- Critical + Major findings block the dimension from being marked `closed`.
