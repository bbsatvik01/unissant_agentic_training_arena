---
applyTo: "{packages,services}/**"
description: "Four roles, one credential each, enforced import boundaries and boot checks."
---

# Roles and boot checks

| Role | Package | DSN env var |
| --- | --- | --- |
| api | `arena_api` | `ARENA_PUBLIC_DSN` |
| subject | `arena_subject` | `ARENA_SUBJECT_DSN` |
| referee | `arena_referee` | `ARENA_REFEREE_DSN` |
| tournament | `arena_tournament` | `ARENA_PUBLIC_DSN` |

- `arena_api` and `arena_tournament` never import `arena_subject` or `arena_referee`; `arena_subject` never imports `arena_referee`; `arena_core` imports no role package; only `arena_core.providers.vertex` imports `google.genai`; nothing imports `google.adk`; product code never touches the import system (`importlib` in full, `runpy`, `pkgutil`, `pydoc`, `site`, `__import__`, `sys.path`, `sys.modules`) and never names a forbidden module as a dotted string (`"arena_referee.app:app"`), so every module it loads is a static import the lint can see. `tools/check_roles.py` enforces this (S5 1.2).
- Every role's `python -m arena_<role>` calls `arena_core.config.boot(role)` first (S5 1.3). It refuses: a Google or Gemini API key, a missing `ARENA_GCP_PROJECT`, `ARENA_GCP_PROJECT=kbg-production`, an extra or missing DSN, `ARENA_OWNER_DSN`, an `ARENA_ENV` other than `local` or `hosted`, `ARENA_ENV=local` on Cloud Run (`K_SERVICE` set), and in local mode any `ARENA_BIND_HOST` other than `127.0.0.1`.
- Hidden case families (`cases/hidden/`, D-014) are git-ignored and never committed or read by a gate.
- Hosting is GCP, scale to zero. Never min-instances >= 1 or CPU always-allocated.
