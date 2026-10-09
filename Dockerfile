# Hosted-variant image skeleton (WP-33, owner decision OD-10; S5 9.1). Not built in WP-01 -- no role's
# package yet declares a web server or a console-script entry point, so there is nothing to run.
# Kept so WP-33 can wire a real CMD without redesigning the build:
#   docker build -t arena .
# One image, every role (`ARENA_ROLE=api|subject|referee|tournament` at `docker run` time): a web build
# stage (added once web/ exists, WP-18) and a uv sync stage, pinned by digest (T27 adapt: no Chromium,
# unlike TechnoMile's bh-api image -- the arena has no server-side rendering).
#
# Base image digests are TechnoMile's own already-verified pins (services/api/Dockerfile, read 2026-10-08;
# ATTRIBUTIONS.md), reused here because the hosted variant is not built or deployed from this WP
# (global scale-to-zero gate: nothing in this file is applied until WP-33 and an explicit owner
# approval of every infrastructure value).

FROM ghcr.io/astral-sh/uv:0.11.2@sha256:c4f5de312ee66d46810635ffc5df34a1973ba753e7241ce3a08ef979ddd7bea5 AS uv

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e AS build
COPY --from=uv /uv /usr/local/bin/uv
ENV UV_LINK_MODE=copy UV_COMPILE_BYTECODE=1 UV_PYTHON_DOWNLOADS=never
WORKDIR /app
COPY pyproject.toml uv.lock ./
COPY packages ./packages
COPY services ./services
# --no-editable: every service package, not one (ARENA_ROLE picks the role at `docker run` time).
RUN uv sync --locked --no-dev --no-editable

FROM python:3.12-slim-bookworm@sha256:392307d22300de8b5986851a12d9176dfc0fc073e65bf6523ebd7dcbeb23564e
ENV PATH=/app/.venv/bin:$PATH \
    PYTHONUNBUFFERED=1
COPY --from=build /app/.venv /app/.venv
RUN useradd --system --uid 10001 --no-create-home arena
USER arena
EXPOSE 8080
# arena-serve (WP-33): dispatches on ARENA_ROLE to uvicorn (api/subject/referee) or the job main
# (tournament). Until it exists, this CMD only proves the image boots and runs the role's own boot
# checks (S5 1.3) -- the same entry point `make dev` (WP-05) and `python -m <role package>` use locally.
CMD ["sh", "-c", "exec python -m arena_${ARENA_ROLE:?set ARENA_ROLE}"]
