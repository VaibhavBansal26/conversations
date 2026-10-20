#!/usr/bin/env bash
# Measurement runs sized for a shared 8 GB laptop whose kernel file table (kern.maxfiles 30720) is also used by other processes.
# Every scenario waits for a quiet machine and records the load average it started under (see results/*.json "machine").
set -u
cd "$(dirname "$0")"
mkdir -p results
Q="--quiet-load ${QUIET_LOAD:-24} --quiet-wait ${QUIET_WAIT:-900}"
run() { name=$1; out=$2; shift 2; echo "=== $name -> $out ($(date +%T), load $(sysctl -n vm.loadavg))"; node run.mjs "$name" "$@" $Q --out "results/$out.json" > "results/$out.log" 2>&1; [ -f "results/$out.json" ] && node summary.mjs "results/$out.json" | cut -c1-500 | head -12; }

run multinode scaleout-3node  --nodes 3 --db postgres --redis true --conns 3000 --agents 4 --rate 200 --duration 45 --workers 3
run multinode scaleout-4node  --nodes 4 --db postgres --redis true --conns 4000 --agents 4 --rate 267 --duration 45 --workers 4
run storm     storm-3node     --nodes 3 --conns 3000 --agents 2 --rate 150 --workers 4 --connect-rate 500
run slow      slow-2node      --nodes 2 --conns 800 --agents 6 --rate 120 --duration 25 --workers 2
run idempotency idem-3node    --nodes 3
run rest      rest-pg         --nodes 1 --db postgres --redis false --conns 1000 --connections 64 --duration 10
run rest      rest-sqlite     --nodes 1 --db sqlite --redis false --conns 1000 --connections 64 --duration 10
run drain     drain-2node     --nodes 2 --conns 800 --agents 2 --rate 80 --workers 2
node hotroom.mjs --writers 1,10,100,1000 --seconds 8 --out results/hotroom.json > results/hotroom.log 2>&1
run roomsize  roomsize        --nodes 1 --db postgres --redis false --rate 40 --duration 15 --workers 3 --sizes 1,10,100,1000 --conns 50
run soak      soak-30min      --nodes 2 --conns 1500 --agents 3 --rate 60 --duration 1800 --workers 3
echo "suite3 done $(date +%T)"
