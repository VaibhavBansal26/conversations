#!/usr/bin/env bash
# The full measurement suite used for docs/PERFORMANCE.md. ~45 minutes. Needs: npm run build --prefix ../server, redis-server on PATH.
# Each scenario waits for a quiet machine (load average below --quiet-load) because the harness shares the box with the system under test.
set -u
cd "$(dirname "$0")"
mkdir -p results
Q="--quiet-load ${QUIET_LOAD:-14} --quiet-wait ${QUIET_WAIT:-900}"
run() { name=$1; out=$2; shift 2; echo "=== $name -> $out ($(date +%T))"; node run.mjs "$name" "$@" $Q --out "results/$out.json" > "results/$out.log" 2>&1; node summary.mjs "results/$out.json" | cut -c1-400 | head -12; }

run ramp          ramp-10k-4node      --nodes 4 --conns 10000 --workers 6 --connect-rate 700
run fanout        fanout-1node-sqlite --nodes 1 --db sqlite --redis false --conns 5000 --agents 5 --rate 200 --duration 60 --workers 4
run fanout        fanout-1node-pg     --nodes 1 --db postgres --redis false --conns 5000 --agents 5 --rate 200 --duration 60 --workers 4
run multinode     multinode-4node-8k  --nodes 4 --conns 8000 --agents 5 --rate 300 --duration 60 --workers 6
run storm         storm-4node-8k      --nodes 4 --conns 8000 --agents 2 --rate 200 --workers 6 --connect-rate 700
run slow          slow-2node          --nodes 2 --conns 1000 --agents 6 --rate 150 --duration 30 --workers 2
run idempotency   idem-1node          --nodes 1
run idempotency   idem-3node          --nodes 3
run rest          rest-sqlite         --nodes 1 --db sqlite --redis false --conns 2000 --connections 64 --duration 10
run rest          rest-pg             --nodes 1 --db postgres --redis false --conns 2000 --connections 64 --duration 10
run drain         drain-2node         --nodes 2 --conns 1000 --agents 2 --rate 100 --workers 2
run soak          soak-4node-10min    --nodes 4 --conns 5000 --agents 3 --rate 100 --duration 600 --workers 4
echo "suite done $(date +%T)"
