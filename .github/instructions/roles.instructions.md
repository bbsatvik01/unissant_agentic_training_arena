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

- `arena_api` and `arena_tournament` never import `arena_subject` or `arena_referee`; `arena_subject` never imports `arena_referee`; only `arena_core.providers.vertex` imports `google.genai`; nothing imports `google.adk`. `tools/check_roles.py` enforces this.
- Every role calls `arena_core.config.boot(role)` first. It refuses: a Google or Gemini API key, a missing `ARENA_GCP_PROJECT`, `ARENA_GCP_PROJECT=kbg-production`, an extra or missing DSN, `ARENA_OWNER_DSN`, `ARENA_ENV=local` on Cloud Run, and a non-loopback bind in local mode.
- Hosting is GCP, scale to zero. Never min-instances >= 1 or CPU always-allocated.
