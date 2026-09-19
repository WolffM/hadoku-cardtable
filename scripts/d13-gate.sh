#!/usr/bin/env bash
#
# The image-boundary gate: D13 as amended by D15.
#
# Usage:
#   scripts/d13-gate.sh <dir>        # check a built bundle, normally apps/ui/dist
#   scripts/d13-gate.sh --self-test  # prove every arm, in every quoting
#
# ── What this checks, and why it is not "no images" ──────────────────────────
#
# D13 said "never commit, host, mirror, cache or proxy card images". The
# operator repealed the hosting half on 2026-09-15 (`docs/DECISIONS.md` D15):
# card art now lives on `cdn.hadoku.me`. What SURVIVED is the part this gate
# exists for — **the app's own origin serves no image bytes.** We serve the
# app; something else serves the pictures.
#
# Against the artifact that actually reaches a browser:
#
#   1. no image BYTES ship — no image file in the tree, and no `data:image/…`
#      URI inlining bytes into the JS/CSS by the back door;
#   2. no `image_uris` / `image_status` / `art_crop` blob copied out of
#      Scryfall's records — the payload carries an id and the client builds
#      the URL. This is what keeps a card's art a LOOKUP rather than a URL,
#      so re-sourcing the art stays a one-line data edit.
#
# ── What this gate NO LONGER checks (D18, operator 2026-09-19) ───────────────
#
# It used to require every image URL to be on `cards.scryfall.io` or
# `cdn.hadoku.me`, and failed a relative or same-origin one. That enforced
# "our own origin never serves an image" — a belt-and-braces rule on top of
# the things that actually carry the licensing argument: no money, the friend
# gate, a handful of players, and the disclaimer in `NOTICE.md`.
#
# The operator repealed it: *"i dont care to follow this strictness regarding
# the WOTC ip"*. Fifty reference fixtures went with it. `docs/LICENSING.md`
# §3.1 keeps the original argument, because a rule that changes without a
# recorded reason is one that flips back.
#
# The two arms above survive for reasons that are NOT about copyright: a
# 5.85 MB PNG inlined into a JS chunk is a performance bug whoever owns it,
# and the metadata rule is an architecture rule the operator asked for.
#
readonly EXT_RE='(jpe?g|png|webp|gif|avif)'

# A maximal run of characters that can appear in a URL or path, ending in an
# image extension. `+` rather than `*` on purpose: a bare `.jpg` with no path
# character in front of it is punctuation in prose, not a reference.

# What a browser loads and executes. See the header for why `*.map` is absent.
readonly -a SCAN_INCLUDES=(
  --include='*.html' --include='*.htm'
  --include='*.js'   --include='*.mjs' --include='*.cjs'
  --include='*.css'
)

run_gate() {
  local dist="$1"

  # ── Arm 1a: no image files shipped ─────────────────────────────────────────
  local -a image_files
  mapfile -t image_files < <(
    find "$dist" -type f \( -iname '*.jpg' -o -iname '*.jpeg' -o -iname '*.png' \
      -o -iname '*.webp' -o -iname '*.gif' -o -iname '*.avif' \) | sort
  )
  if (( ${#image_files[@]} > 0 )); then
    echo "::error::D13/D15 — the bundle ships ${#image_files[@]} image file(s). The app serves no image bytes of its own."
    printf '  %s\n' "${image_files[@]:0:20}"
    return 1
  fi

  # ── Arm 1b: no image bytes inlined as a data: URI ──────────────────────────
  # The other way bytes reach a browser from our origin. A `data:image/png`
  # blob in the JS or CSS is us hosting the image, just spelled differently.
  local -a data_uris
  mapfile -t data_uris < <(
    grep -rIl "${SCAN_INCLUDES[@]}" -E "data:image/${EXT_RE}[;,]" "$dist" 2>/dev/null | sort || true
  )
  if (( ${#data_uris[@]} > 0 )); then
    echo "::error::D13/D15 — ${#data_uris[@]} file(s) inline image bytes as a data: URI. That is still us serving the bytes."
    printf '  %s\n' "${data_uris[@]:0:20}"
    return 1
  fi

  # ── Arm 5: no copied upstream image metadata ───────────────────────────────
  local -a meta_files
  mapfile -t meta_files < <(
    grep -rIlE '"image_uris"|"image_status"|"art_crop"' "$dist" 2>/dev/null | sort || true
  )
  if (( ${#meta_files[@]} > 0 )); then
    echo "::error::D13/D15 — ${#meta_files[@]} file(s) carry a Scryfall image blob (image_uris / image_status / art_crop). Carry the id, build the URL."
    printf '  %s\n' "${meta_files[@]:0:20}"
    return 1
  fi

  echo "d13-gate: $dist OK — 0 image files shipped, 0 inlined image data: URIs, 0 copied Scryfall image metadata blobs. Image URLs are not restricted by host (D18, operator 2026-09-19)."

  return 0
}

# ── Self-test ────────────────────────────────────────────────────────────────
#
# Every arm, both directions, and every reference case in all five quotings.
# Fixtures are written under `mktemp -d`, never in the worktree: `.gitignore`
# refuses `*.jpg`/`*.png`, and arm 1 of this very gate would catch a stray one.
SELF_TEST_TMP=''
# Global, not `local`: an EXIT trap runs after the function's locals are gone,
# and referencing one there dies with "unbound variable" under `set -u` —
# turning a clean self-test into a spurious exit 1.
cleanup_self_test() { [[ -n "$SELF_TEST_TMP" ]] && rm -rf "$SELF_TEST_TMP"; return 0; }

# Write `token` into `dir` in one of the five spellings a reference can take in
# a real bundle.
emit_ref() {
  local dir="$1" form="$2" token="$3"
  mkdir -p "$dir"
  case "$form" in
    dq)   printf 'const a="%s";\n'              "$token" > "$dir/index.js" ;;
    sq)   printf "const a='%s';\n"              "$token" > "$dir/index.js" ;;
    bt)   printf 'const a=`%s`;\n'              "$token" > "$dir/index.js" ;;
    css)  printf '.c{background:url(%s)}\n'     "$token" > "$dir/index.css" ;;
    html) printf '<img src=%s>\n'               "$token" > "$dir/index.html" ;;
    *)    echo "emit_ref: unknown form $form" >&2; return 1 ;;
  esac
}

self_test() {
  local tmp; tmp="$(mktemp -d)"; SELF_TEST_TMP="$tmp"
  trap cleanup_self_test EXIT

  local h64 hb64 upper sf
  h64="$(printf 'a1%.0s' {1..32})"   # 64 lowercase hex characters
  hb64="$(printf 'b2%.0s' {1..32})"
  upper="$(printf 'A1%.0s' {1..32})"
  sf='https://cards.scryfall.io/normal/front/a/1/a1b2c3d4-0000-0000-0000-000000000000.jpg'

  local mismatches=0 passed=0 failed=0 total=0

  # assert <name> <expect PASS|FAIL> <why>
  assert_fixture() {
    local name="$1" expect="$2" why="$3" code=0 got verdict
    run_gate "$tmp/$name" >/dev/null 2>&1 || code=$?
    if (( code == 0 )); then got=PASS; else got=FAIL; fi
    total=$(( total + 1 ))
    if [[ "$got" == "$expect" ]]; then
      verdict=ok; passed=$(( passed + 1 ))
    else
      verdict='MISMATCH'; mismatches=$(( mismatches + 1 )); failed=$(( failed + 1 ))
    fi
    printf '  %-8s %-28s expect=%-4s exit=%-2s  %s\n' "$verdict" "$name" "$expect" "$code" "$why"
  }

  # ── Bytes, data URIs, metadata, and the quiet cases ────────────────────────
  #
  # Arms 2-4 — the host allowlist — were removed on 2026-09-19 (D18): the
  # operator repealed "our own origin never serves an image". Their 50
  # reference fixtures went with them. What is left is what still bites: no
  # image BYTES in the bundle (arm 1), and no copied Scryfall image blob
  # (arm 5), which is what keeps a card's art a lookup rather than a URL.
  echo "  ── bytes, data: URIs, metadata, and the quiet cases ──"
  mkdir -p "$tmp"/{bytes-jpg,bytes-PNG,data-uri-png,data-uri-css,meta-image-uris} \
           "$tmp"/{meta-image-status,meta-art-crop,clean,empty}
  printf 'console.log(1)\n'                  > "$tmp/bytes-jpg/index.js"
  printf '\xff\xd8\xff\xe0JFIF'              > "$tmp/bytes-jpg/card.jpg"
  assert_fixture bytes-jpg FAIL "arm 1a: a shipped .jpg is image bytes"
  printf 'console.log(1)\n'                  > "$tmp/bytes-PNG/index.js"
  printf '\x89PNG'                           > "$tmp/bytes-PNG/CARD.PNG"
  assert_fixture bytes-PNG FAIL "arm 1a: uppercase extensions count too"
  printf 'const a="data:image/png;base64,iVBORw0KGgo=";\n' > "$tmp/data-uri-png/index.js"
  assert_fixture data-uri-png FAIL "arm 1b: inlined bytes are still bytes"
  printf '.c{background:url(data:image/jpeg;base64,/9j/4AAQ)}\n' > "$tmp/data-uri-css/index.css"
  assert_fixture data-uri-css FAIL "arm 1b: inlined bytes in CSS too"
  printf '{"image_uris":{"normal":"x"}}\n'   > "$tmp/meta-image-uris/index.js"
  assert_fixture meta-image-uris FAIL "arm 5: copied image_uris"
  printf '{"image_status":"highres_scan"}\n' > "$tmp/meta-image-status/index.js"
  assert_fixture meta-image-status FAIL "arm 5: copied image_status"
  printf '{"art_crop":"x"}\n'                > "$tmp/meta-art-crop/index.js"
  assert_fixture meta-art-crop FAIL "arm 5: copied art_crop"
  printf 'const greeting="hello";\n'         > "$tmp/clean/index.js"
  printf 'body{color:red}\n'                 > "$tmp/clean/index.css"
  assert_fixture clean PASS "a bundle with no image references at all"
  assert_fixture empty PASS "an empty directory"

  echo "d13-gate --self-test: ${total} fixtures, ${passed} as expected, ${failed} mismatched."
  if (( mismatches > 0 )); then
    echo "::error::d13-gate self-test: ${mismatches} fixture(s) did not behave as specified."
    return 1
  fi
  return 0
}

main() {
  local arg="${1:-}"
  if [[ "$arg" == "--self-test" ]]; then
    self_test
    return $?
  fi
  if [[ -z "$arg" ]]; then
    echo "::error::d13-gate: usage: $0 <dir> | --self-test" >&2
    return 2
  fi
  if [[ ! -d "$arg" ]]; then
    echo "::error::d13-gate: not a directory: $arg" >&2
    return 2
  fi
  run_gate "$arg"
}

main "$@"
