#!/usr/bin/env bash
# Install the pinned, sha256-verified security binaries the gate needs (S5 11.1 sec-check), then link them
# into .tools/bin.
#   gitleaks 8.30.1, trufflehog 3.97.5, osv-scanner 2.6.0, CodeQL bundle 2.27.0
#   tools/ensure_tools.sh            all four (what `make tools-sync` runs)
#   tools/ensure_tools.sh gitleaks   only the named ones (a CI job that needs one scanner)
# Versions respect the 7-day release cooldown (global pre-push bar). Every checksum below equals the digest
# GitHub publishes for that release asset (re-checked 2026-10-08). Downloads are cached per version in
# ${ARENA_TOOLS_CACHE:-$HOME/.cache/arena-tools} so clean clones do not re-download (the CodeQL bundle
# unpacks to ~3.3 GB; point ARENA_TOOLS_CACHE at an existing cache populated by this same script to reuse
# it). Fails closed: an unknown tool name, an unsupported platform or a checksum mismatch aborts, and nothing
# falls back to a tool on PATH. Lifted from TechnoMile tools/ensure_tools.sh (ATTRIBUTIONS.md); the cache
# variable and the optional tool selection are this repo's.
set -euo pipefail

ALL_TOOLS=(gitleaks trufflehog osv-scanner codeql)
if (($# == 0)); then
  WANT=("${ALL_TOOLS[@]}")
else
  WANT=("$@")
fi
for tool in "${WANT[@]}"; do
  case " ${ALL_TOOLS[*]} " in
    *" $tool "*) ;;
    *) echo "ensure_tools: unknown tool '$tool' (one of: ${ALL_TOOLS[*]})" >&2; exit 1 ;;
  esac
done
wants() { case " ${WANT[*]} " in *" $1 "*) return 0 ;; *) return 1 ;; esac; }

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CACHE="${ARENA_TOOLS_CACHE:-$HOME/.cache/arena-tools}"
BIN_DIR="$ROOT/.tools/bin"
mkdir -p "$CACHE" "$BIN_DIR"

case "$(uname -s)_$(uname -m)" in
  Darwin_arm64) PLAT="darwin_arm64" ;;
  Darwin_x86_64) PLAT="darwin_amd64" ;;
  Linux_x86_64) PLAT="linux_amd64" ;;
  *) echo "ensure_tools: unsupported platform $(uname -s)_$(uname -m)" >&2; exit 1 ;;
esac

sha_for() { # $1 = tool, prints the pinned sha256 for this platform's asset
  case "$1:$PLAT" in
    gitleaks:darwin_arm64) echo b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5 ;;
    gitleaks:darwin_amd64) echo dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709 ;;
    gitleaks:linux_amd64) echo 551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb ;;
    trufflehog:darwin_arm64) echo b4e5fd54aaea368342b226cbea228e7a33898b177598d1d8cd66edb14f87444e ;;
    trufflehog:darwin_amd64) echo cc8b12f8120fe47d7de929928e9183285b7a39eba60b3ac01f085f522ec19e50 ;;
    trufflehog:linux_amd64) echo e3d97199c565c37ca6152750197f667e08ae6a1edf5911fbdec168622b28620c ;;
    osv-scanner:darwin_arm64) echo 98c460dcd37de25819babd757d04542045b6243113e209edcd4d89fedb0256b4 ;;
    osv-scanner:darwin_amd64) echo 60c5296637e977b28eeda5c7f13573e447659a632922737f94d11fa7e30ad6ca ;;
    osv-scanner:linux_amd64) echo ca69b3d3cd08f889a49dc0a383122f71cc528b83803671df5fd874d97485b108 ;;
    codeql:darwin_*) echo 84e5f9d804ae58c41930c33cd61cbeffdbca86689fc85f2f89a2ab0eec433bd6 ;;
    codeql:linux_amd64) echo 5e0f04bcb92c0c0973b6f5597e55316269051fa98bda3f725d8af9a85016721a ;;
    *) echo "ensure_tools: no pinned checksum for $1 on $PLAT" >&2; return 1 ;;
  esac
}

fetch() { # $1 = url, $2 = dest, $3 = sha256
  local tmp="$2.part"
  curl --fail --silent --show-error --location --proto '=https' --tlsv1.2 -o "$tmp" "$1"
  if ! echo "$3  $tmp" | shasum -a 256 -c - >/dev/null; then
    rm -f "$tmp"
    echo "ensure_tools: checksum mismatch for $1" >&2
    exit 1
  fi
  mv "$tmp" "$2"
}

install_tarball_binary() { # $1 tool, $2 version, $3 url, $4 binary name inside the tarball
  local dir="$CACHE/$1-$2"
  if [[ ! -x "$dir/$4" ]]; then
    mkdir -p "$dir"
    fetch "$3" "$dir/asset.tar.gz" "$(sha_for "$1")"
    tar -xzf "$dir/asset.tar.gz" -C "$dir" "$4"
    rm -f "$dir/asset.tar.gz"
  fi
  ln -sfn "$dir/$4" "$BIN_DIR/$1"
}

GL=8.30.1
TH=3.97.5
OSV=2.6.0
CQ=2.27.0
READY=()

if wants gitleaks; then
  GL_ASSET="${PLAT/amd64/x64}"
  install_tarball_binary gitleaks "$GL" \
    "https://github.com/gitleaks/gitleaks/releases/download/v$GL/gitleaks_${GL}_${GL_ASSET}.tar.gz" gitleaks
  "$BIN_DIR/gitleaks" version >/dev/null
  READY+=("gitleaks $GL")
fi

if wants trufflehog; then
  install_tarball_binary trufflehog "$TH" \
    "https://github.com/trufflesecurity/trufflehog/releases/download/v$TH/trufflehog_${TH}_${PLAT}.tar.gz" trufflehog
  "$BIN_DIR/trufflehog" --version >/dev/null 2>&1
  READY+=("trufflehog $TH")
fi

if wants osv-scanner; then
  OSV_DIR="$CACHE/osv-scanner-$OSV"
  if [[ ! -x "$OSV_DIR/osv-scanner" ]]; then
    mkdir -p "$OSV_DIR"
    fetch "https://github.com/google/osv-scanner/releases/download/v$OSV/osv-scanner_$PLAT" \
      "$OSV_DIR/osv-scanner" "$(sha_for osv-scanner)"
    chmod 0755 "$OSV_DIR/osv-scanner"
  fi
  ln -sfn "$OSV_DIR/osv-scanner" "$BIN_DIR/osv-scanner"
  "$BIN_DIR/osv-scanner" --version >/dev/null
  READY+=("osv-scanner $OSV")
fi

if wants codeql; then
  CQ_DIR="$CACHE/codeql-$CQ"
  case "$PLAT" in darwin_*) CQ_ASSET="osx64" ;; *) CQ_ASSET="linux64" ;; esac
  if [[ ! -x "$CQ_DIR/codeql/codeql" ]]; then
    command -v zstd >/dev/null || { echo "ensure_tools: zstd is required to unpack CodeQL (brew install zstd)" >&2; exit 1; }
    mkdir -p "$CQ_DIR"
    fetch "https://github.com/github/codeql-action/releases/download/codeql-bundle-v$CQ/codeql-bundle-$CQ_ASSET.tar.zst" \
      "$CQ_DIR/bundle.tar.zst" "$(sha_for codeql)"
    zstd -dc "$CQ_DIR/bundle.tar.zst" | tar -x -C "$CQ_DIR"
    rm -f "$CQ_DIR/bundle.tar.zst"
  fi
  ln -sfn "$CQ_DIR/codeql/codeql" "$BIN_DIR/codeql"
  "$BIN_DIR/codeql" version --format=terse >/dev/null
  READY+=("codeql $CQ")
fi

summary="$(printf '%s, ' "${READY[@]}")"
echo "ensure_tools: ${summary%, } ready in .tools/bin"
