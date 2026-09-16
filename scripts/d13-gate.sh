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
#   2. an absolute image URL must be `https://cards.scryfall.io/` or
#      `https://cdn.hadoku.me/`, and nothing else;
#   3. a same-origin or relative image URL FAILS — `/…`, `./…`, `../…`, or
#      anything naming `hadoku.me/cardtable`. This is the assertion the whole
#      gate exists for and it did not change with D15;
#   4. a bare content-addressed CDN key is TOLERATED as the key it is. A
#      manifest row stores `{ source: 'cdn', key: '<sha256>.jpg' }` — the key
#      is a filename, not a URL. A key is 64 hex characters plus an extension,
#      matching `isCdnKey` in `packages/carddata/src/art/index.ts`.
#      `deadbeef.jpg` is NOT a key and still fails;
#   5. no `image_uris` / `image_status` / `art_crop` blob copied out of
#      Scryfall's records — the payload carries an id and the client builds
#      the URL.
#
# ── How references are extracted, and the bug that taught us ─────────────────
#
# **Do not reintroduce a quote-anchored regex here.** Both previous versions of
# this check extracted `"[^"]*\.(jpe?g|png|…)"` — double-quoted strings only.
# Vite's minifier emits string literals as **template literals**:
#
#     d730":{source:`cdn`,key:`a7b624f1…e86ea7fb.jpg`}}};
#
# so the check was blind to the artifact it guarded. A same-origin URL written
# `` `/cardtable/art/x.jpg` `` passed; the identical string in double quotes
# failed. A fixture set that shares one assumption with the extractor proves
# nothing about that assumption — which is why every reference fixture below is
# generated in FIVE forms: double-quoted, single-quoted, backtick, bare inside
# CSS `url(...)`, and bare in an HTML attribute.
#
# So extraction is **delimiter-agnostic**: a maximal run of URL/path characters
# ending in an image extension, however it is quoted or not quoted at all.
#
# ── Which files arms 2-4 read, and why it is not everything ──────────────────
#
# Arms 2-4 read only what a browser loads and executes: `.html`, `.js`, `.mjs`,
# `.cjs`, `.css`. **Sourcemaps are deliberately excluded**, and that is a tested
# decision, not an oversight (`map-noise` / `map-noise-control` below).
#
# A `.js.map` carries `sourcesContent` — the ORIGINAL source, comments and all.
# Verified against the real bundle: a delimiter-agnostic scan of
# `apps/ui/dist/assets/*.js.map` returns `deadbeef.jpg`, which is prose from a
# code comment explaining what is NOT a valid key. Failing the build on that is
# how a gate earns its own `# disabled, too noisy` comment.
#
# Nothing is lost by the exclusion: a string that reaches runtime is emitted
# into the `.js`, so any real reference is caught there. A string that exists
# only in a sourcemap comment is not a reference — the browser never fetches
# it. The `map-noise-control` fixture asserts exactly this: the same token in
# `.js` fails, in `.js.map` passes.
#
# ── What this gate structurally CANNOT catch ────────────────────────────────
#
# A URL assembled at runtime from parts, where no part ends in an image
# extension. `resolveArtUrl` composes `` `${cdnBase}/${key}` ``, so the real
# bundle contains the host and the key separately and never the whole URL. If
# someone set the base to a same-origin path, the key would still look like a
# legal key and this gate would pass.
#
# That hole is covered somewhere a text scan cannot reach: `cardImage.test.ts`
# and `packages/carddata/src/art/index.test.ts` assert that the resolver's
# *composed output* has an origin in `ALLOWED_ART_HOSTS`. Bundle-grep checks
# literals; the unit tests check composition. Neither substitutes for the
# other, and removing either leaves the invariant half-guarded.
#
# ── Why this is a file and not an inline `run:` block ────────────────────────
#
# Because the only way to exercise an inline block is to run CI. That is
# precisely how the backtick blindness above survived review. `--self-test`
# builds throwaway fixtures under `mktemp -d` and asserts the exit code of
# each, in BOTH directions, so a green run is a demonstration and not a claim.
#
# Exercise it against FIXTURES. Never disable an arm and run it against the
# real bundle — that is the failure the gate exists to stop.

set -euo pipefail

# A CDN key: sha256 of the object's bytes, plus an extension. Kept deliberately
# in step with `CDN_KEY_PATTERN` / `isCdnKey` in packages/carddata/src/art/index.ts.
# Anchored at both ends: a key is the WHOLE token or it is not a key.
readonly KEY_RE='^[0-9a-f]{64}\.[a-z0-9]{1,8}$'

# The two origins an image may come from. The trailing slash is load-bearing:
# without it `https://cdn.hadoku.me.evil.example/x.jpg` would be accepted.
readonly ALLOWED_RE='^https://(cards\.scryfall\.io|cdn\.hadoku\.me)/'

# The image extensions this gate knows about, as a grep alternation.
readonly EXT_RE='(jpe?g|png|webp|gif|avif)'

# A maximal run of characters that can appear in a URL or path, ending in an
# image extension. `+` rather than `*` on purpose: a bare `.jpg` with no path
# character in front of it is punctuation in prose, not a reference.
readonly REF_RE="[A-Za-z0-9_.:/~%+@-]+\\.${EXT_RE}"

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

  # ── Arms 2-4: every image reference is an allowed URL or a CDN key ─────────
  local -a tokens
  mapfile -t tokens < <(
    grep -rIoh "${SCAN_INCLUDES[@]}" -iE "$REF_RE" "$dist" 2>/dev/null | sort -u || true
  )

  local allowed_urls=0 cdn_keys=0 tok
  local -a offenders=()
  for tok in ${tokens[@]+"${tokens[@]}"}; do
    [[ -z "$tok" ]] && continue
    if [[ "$tok" =~ $ALLOWED_RE ]]; then
      allowed_urls=$(( allowed_urls + 1 ))
    elif [[ "$tok" =~ $KEY_RE ]]; then
      cdn_keys=$(( cdn_keys + 1 ))
    else
      offenders+=("$tok")
    fi
  done

  if (( ${#offenders[@]} > 0 )); then
    echo "::error::D13/D15 — ${#offenders[@]} image reference(s) that are neither an allowed absolute URL nor a CDN key."
    echo "  Allowed: https://cards.scryfall.io/… or https://cdn.hadoku.me/… , or a bare 64-hex CDN key."
    echo "  Forbidden: relative ('./x.jpg', '../x.jpg'), root-relative ('/x.jpg'), or same-origin ('hadoku.me/cardtable/…')."
    echo "  We host on the CDN, never from the app's own origin."
    printf '  %s\n' "${offenders[@]:0:20}"
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

  echo "d13-gate: $dist OK — 0 image files shipped, 0 inlined image data: URIs; ${#tokens[@]} image reference(s) examined (${allowed_urls} allowed absolute URL(s) on cards.scryfall.io/cdn.hadoku.me, ${cdn_keys} bare CDN key(s)); 0 relative or same-origin image URLs; 0 copied Scryfall image metadata blobs."

  # ── Zero references: a pass, but never a silent one ────────────────────────
  #
  # Judgement, written down because it is the kind of thing that gets changed
  # by whoever is annoyed by it that week:
  #
  # Zero references is a PASS. It is a legitimate state — `art-manifest.json`
  # ships empty until the upload CLI has run, and `resolveArtUrl` composes
  # Scryfall URLs at runtime rather than emitting literals — and a gate that
  # red-fails a legitimate state is a gate someone deletes. Arms 1 and 5 still
  # bite in this state; only 2-4 have nothing to look at.
  #
  # But it is NOT a silent pass. A vacuous green is exactly how three separate
  # controls in this repo passed while doing nothing. So the run says out loud
  # that the arms that matter most examined nothing, and what would change that.
  if (( ${#tokens[@]} == 0 )); then
    echo "d13-gate: NOTE — arms 2-4 examined ZERO references, so they proved nothing on this artifact."
    echo "  Not a failure: the art manifest is empty until the upload CLI runs, and art URLs are composed"
    echo "  at runtime rather than emitted as literals. Arms 1 and 5 did run. Once a manifest key lands,"
    echo "  expect a non-zero 'bare CDN key(s)' count above; if it stays 0 after an upload, this gate has"
    echo "  stopped seeing the artifact and THAT is the bug. Run --self-test to confirm the arms still bite."
  fi
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

  # ── Reference cases × five quotings ────────────────────────────────────────
  # name|token|expect|why
  local -a refs=(
    "url-scryfall|$sf|PASS|cards.scryfall.io is allowed"
    "url-cdn|https://cdn.hadoku.me/$h64.jpg|PASS|cdn.hadoku.me is allowed"
    "url-rootrel|/cardtable/art/x.jpg|FAIL|root-relative means WE serve it"
    "url-dotrel|./x.jpg|FAIL|./ is relative"
    "url-dotdotrel|../x.jpg|FAIL|../ is relative"
    "url-sameorigin|https://hadoku.me/cardtable/art/x.jpg|FAIL|our own origin"
    "url-lookalike|https://cdn.hadoku.me.evil.example/$h64.jpg|FAIL|prefix lookalike host"
    "key-64hex|$h64.jpg|PASS|a bare 64-hex key is a key, not a relative URL"
    "key-8hex|deadbeef.jpg|FAIL|8 hex characters is not a key"
    "key-upper|$upper.jpg|FAIL|uppercase hex is not the key shape"
  )
  local -a forms=(dq sq bt css html)
  local entry name token expect why form
  echo "  ── reference cases, each in all five spellings ──"
  for entry in "${refs[@]}"; do
    IFS='|' read -r name token expect why <<< "$entry"
    for form in "${forms[@]}"; do
      emit_ref "$tmp/$name-$form" "$form" "$token"
      assert_fixture "$name-$form" "$expect" "$why [$form]"
    done
  done

  # ── The exact shape Vite actually emits ────────────────────────────────────
  echo "  ── the real minified shape, and the bypass it used to allow ──"
  mkdir -p "$tmp/vite-shape-key" "$tmp/vite-shape-bad"
  printf 'var M={"a1b2c3d4-0000-0000-0000-000000000000":{source:`cdn`,key:`%s.jpg`}};\n' "$h64" \
    > "$tmp/vite-shape-key/index.js"
  assert_fixture vite-shape-key PASS "minified backtick manifest row with a real key"
  printf 'var M={x:{source:`cdn`,key:`%s.jpg`}},b=`/cardtable/art/deadbeef.jpg`;\n' "$h64" \
    > "$tmp/vite-shape-bad/index.js"
  assert_fixture vite-shape-bad FAIL "THE BYPASS: same-origin URL in backticks alongside a legal key"

  # ── Sourcemap scoping, asserted in both directions ─────────────────────────
  echo "  ── sourcemap exclusion is a tested decision, not an oversight ──"
  mkdir -p "$tmp/map-noise" "$tmp/map-noise-control"
  printf '{"version":3,"sourcesContent":["// deadbeef.jpg names no object any more than \\"\\" does"]}\n' \
    > "$tmp/map-noise/index.js.map"
  printf 'console.log(1)\n' > "$tmp/map-noise/index.js"
  assert_fixture map-noise PASS "prose in a sourcemap comment is not a reference"
  printf 'const a=`deadbeef.jpg`;\n' > "$tmp/map-noise-control/index.js"
  assert_fixture map-noise-control FAIL "control: the same token in EXECUTED js still fails"

  # ── Bytes, data URIs, metadata, and the quiet cases ────────────────────────
  echo "  ── bytes, data: URIs, metadata, and the quiet cases ──"
  mkdir -p "$tmp"/{bytes-jpg,bytes-PNG,data-uri-png,data-uri-css,meta-image-uris} \
           "$tmp"/{meta-image-status,meta-art-crop,clean,empty,mixed-pass,mixed-one-bad}
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
  printf 'const a="%s",b=`https://cdn.hadoku.me/%s.jpg`;const m={source:'"'"'cdn'"'"',key:`%s.jpg`};\n' \
    "$sf" "$h64" "$hb64"                     > "$tmp/mixed-pass/index.js"
  assert_fixture mixed-pass PASS "all three quotings at once, all legal"
  printf 'const a="%s",b=`https://cdn.hadoku.me/%s.jpg`;const m={source:'"'"'cdn'"'"',key:`%s.jpg`};const bad='"'"'./oops.png'"'"';\n' \
    "$sf" "$h64" "$hb64"                     > "$tmp/mixed-one-bad/index.js"
  assert_fixture mixed-one-bad FAIL "one single-quoted offender among three legal references"

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
