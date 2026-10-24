#!/bin/sh
# Download a few CRAN package sources and copy their R/*.R files into
# fuzz/corpus/cran/<pkg>/ (smoke runs) and fuzz/corpus/index_queries/ (seeds).
# Usage, from the repo root: fuzz/cran_corpus.sh [pkg ...]
set -eu
pkgs="${*:-cli glue rlang stringr dplyr purrr withr R6 jsonlite magrittr}"
root="fuzz/corpus"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$root/cran" "$root/index_queries"
for p in $pkgs; do
  ver="$(curl -fsSL "https://crandb.r-pkg.org/${p}" | sed -n 's/.*"Version":"\([^"]*\)".*/\1/p' | head -n1)"
  [ -n "$ver" ] || { echo "skip $p: no version" >&2; continue; }
  curl -fsSL -o "$tmp/$p.tar.gz" "https://cloud.r-project.org/src/contrib/${p}_${ver}.tar.gz" \
    || { echo "skip $p: download failed" >&2; continue; }
  mkdir -p "$tmp/x_$p" "$root/cran/$p"
  tar -xzf "$tmp/$p.tar.gz" -C "$tmp/x_$p" "$p/R" 2>/dev/null || { echo "skip $p: no R/" >&2; continue; }
  cp "$tmp/x_$p/$p/R/"*.R "$root/cran/$p/" 2>/dev/null || true
  # Raw R text is a decent seed: the leading String field of the arbitrary
  # input is read from the front of the buffer.
  for f in "$root/cran/$p/"*.R; do
    if [ -f "$f" ] && [ "$(wc -c < "$f")" -lt 20000 ]; then
      cp "$f" "$root/index_queries/${p}_$(basename "$f")"
    fi
  done
done
echo "corpus in $root"
