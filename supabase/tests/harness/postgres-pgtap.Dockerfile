# Plain PostgreSQL 17 with pgTAP, for db-test's plain path (S4 WI-S4-02: the suite runs on plain PostgreSQL 17, the
# owner's project runs 17.11). The official image, no Supabase additions; dblink and pgcrypto ship in its contrib.
# pgTAP 1.3.3 (the version the Supabase image carries) is built from its release tarball, verified by sha256.
# Base pinned by digest; the tag is older than the 7-day supply-chain cooldown. Bump deliberately.
FROM postgres:17.11-alpine3.24@sha256:b0f9560a2de083e2cc7382e75f808c7381a32852a7ec49117deedb300e552b24

ARG PGTAP_VERSION=1.3.3
ARG PGTAP_SHA256=325ea79d0d2515bce96bce43f6823dcd3effbd6c54cb2a4d6c2384fffa3a14c7

RUN set -eux; \
    apk add --no-cache --virtual .pgtap-build make patch perl; \
    wget -q -O /tmp/pgtap.tar.gz "https://github.com/theory/pgtap/archive/refs/tags/v${PGTAP_VERSION}.tar.gz"; \
    echo "${PGTAP_SHA256}  /tmp/pgtap.tar.gz" | sha256sum -c -; \
    mkdir /tmp/pgtap; \
    tar -xzf /tmp/pgtap.tar.gz -C /tmp/pgtap --strip-components=1; \
    make -C /tmp/pgtap install; \
    rm -rf /tmp/pgtap /tmp/pgtap.tar.gz; \
    apk del .pgtap-build; \
    test -f "$(pg_config --sharedir)/extension/pgtap.control"; \
    test -f "$(pg_config --sharedir)/extension/dblink.control"

HEALTHCHECK --interval=1s --timeout=5s --retries=120 CMD pg_isready -U postgres -h 127.0.0.1 || exit 1
