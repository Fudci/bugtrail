#!/bin/bash
# Naikkan beban bertahap; berhenti di tahap pertama yang gagal kriteria.
# Pakai: ramp.sh <label> <url> <key> <compose-project> <count-cmd>
# Kriteria lolos: error < 1%, p95 < 1000 ms, k6 mencapai >= 95% target RPS.
set -u
DIR=$(cd "$(dirname "$0")" && pwd)
LABEL=$1 URL=$2 KEY=$3 PROJ=$4 COUNT_CMD=$5
OUT=$DIR/results/$LABEL
mkdir -p "$OUT"
STEPS=${STEPS:-"1 10 50 100 250 500 1000 2000 5000 10000 20000 50000 100000"}
DURATION=${DURATION:-60s}

# Catat RAM/CPU semua container project ini tiap ~2 detik.
( while true; do
    docker stats --no-stream --format '{{.Name}},{{.CPUPerc}},{{.MemUsage}}' $(docker ps -q --filter "label=com.docker.compose.project=$PROJ") \
      | sed "s/^/$(date +%s),/" >> "$OUT/stats.csv"
    sleep 1
  done ) &
STATS_PID=$!
trap 'kill $STATS_PID 2>/dev/null' EXIT

echo "idle 30s…"; echo "phase,idle,$(date +%s)" >> "$OUT/phases.csv"; sleep 30

printf "%-7s %-8s %-8s %-8s %-8s %-8s %-9s %-10s %s\n" target actual err% p50ms p95ms p99ms sent stored verdict | tee "$OUT/summary.txt"
for R in $STEPS; do
  echo "phase,$R,$(date +%s)" >> "$OUT/phases.csv"
  BEFORE=$(eval "$COUNT_CMD")
  docker run --rm -i ${NET:+--network $NET} -v "$DIR":/b grafana/k6:latest run --quiet \
    --summary-export "/b/results/$LABEL/k6-$R.json" \
    -e RATE=$R -e DURATION=$DURATION -e URL="$URL" -e KEY="$KEY" /b/ingest.js > "$OUT/k6-$R.log" 2>&1
  # Tunggu antrian di server habis (maks 120 dtk) sebelum hitung event tersimpan.
  sleep 5; PREV=-1
  for i in $(seq 1 24); do C=$(eval "$COUNT_CMD"); [ "$C" = "$PREV" ] && break; PREV=$C; sleep 5; done
  STORED=$(( $(eval "$COUNT_CMD") - BEFORE ))
  read -r ACT ERR P50 P95 P99 SENT < <(python3 - "$OUT/k6-$R.json" <<'PY'
import json,sys
m=json.load(open(sys.argv[1]))["metrics"]
d=m.get("http_req_duration",{}); f=m.get("http_req_failed",{}); r=m.get("http_reqs",{})
print(round(r.get("rate",0),1), round(100*f.get("value",f.get("rate",0)),2), round(d.get("med",0)), round(d.get("p(95)",0)), round(d.get("p(99)",0)), int(r.get("count",0)))
PY
)
  V=PASS
  python3 -c "import sys; sys.exit(0 if $ERR<1 and $P95<1000 and $ACT>=0.95*$R else 1)" || V=FAIL
  printf "%-7s %-8s %-8s %-8s %-8s %-8s %-9s %-10s %s\n" $R $ACT $ERR $P50 $P95 $P99 $SENT $STORED $V | tee -a "$OUT/summary.txt"
  [ $V = FAIL ] && break
done
echo "phase,end,$(date +%s)" >> "$OUT/phases.csv"
