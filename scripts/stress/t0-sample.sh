#!/usr/bin/env bash
# T0: sample live PlayBridge match JVMs, read-only. Never attaches to a JVM:
# /proc/<pid>/{stat,smaps_rollup,status} plus jstat, which reads the hsperfdata
# mmap file (no attach, no GC). Never touches fifos under the play dir.
# Usage: t0-sample.sh <out.tsv> [interval_s=30] [duration_s=14400]
set -u
out=$1; iv=${2:-30}; dur=${3:-14400}
JSTAT=${JSTAT:-$HOME/.local/opt/jdk-21.0.12.1+1/bin/jstat}
tck=$(getconf CLK_TCK)
[ -s "$out" ] || printf 'ts\tpid\tkind\tmatch\tage_s\tcpu_s\trss_kb\tpss_kb\tthreads\theap_used_kb\told_used_kb\tygc\tygct\tfgc\tfgct\tgct\tloadavg1\n' > "$out"
end=$(( $(date +%s) + dur ))
boot=$(awk '/btime/{print $2}' /proc/stat)
while [ "$(date +%s)" -lt "$end" ]; do
  ts=$(date -u +%FT%TZ); la=$(cut -d' ' -f1 /proc/loadavg)
  for p in $(pgrep -f '[P]layBridge'); do
    cmd=$(tr '\0' ' ' < /proc/$p/cmdline 2>/dev/null) || continue
    case $cmd in *--spare*) continue;; esac
    case $cmd in *tmpdir=/tmp/cardtable-play/*) kind=prod;; *cardtable-ppe*) kind=ppe;; *) kind=other;; esac
    match=$(sed -nE 's/.*tmpdir=[^ ]*\/(m-[0-9a-f]+)\/tmp.*/\1/p' <<<"$cmd")
    read -r ut st start < <(awk '{print $14, $15, $22}' /proc/$p/stat 2>/dev/null) || continue
    cpu=$(awk -v a=$ut -v b=$st -v t=$tck 'BEGIN{printf "%.2f",(a+b)/t}')
    age=$(( $(date +%s) - boot - start / tck ))
    rss=$(awk '/^Rss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null)
    pss=$(awk '/^Pss:/{print $2}' /proc/$p/smaps_rollup 2>/dev/null)
    thr=$(awk '/^Threads:/{print $2}' /proc/$p/status 2>/dev/null)
    g=$("$JSTAT" -gc "$p" 2>/dev/null | tail -1)
    # jstat -gc (21): S0C S1C S0U S1U EC EU OC OU MC MU CCSC CCSU YGC YGCT FGC FGCT CGC CGCT GCT
    read -r heap old ygc ygct fgc fgct gct < <(awk '{printf "%.0f %.0f %s %s %s %s %s\n",$3+$4+$6+$8,$8,$13,$14,$15,$16,$19}' <<<"$g")
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "$ts" "$p" "$kind" "${match:-?}" "$age" "$cpu" "$rss" "$pss" "$thr" "$heap" "$old" "$ygc" "$ygct" "$fgc" "$fgct" "$gct" "$la" >> "$out"
  done
  sleep "$iv"
done
