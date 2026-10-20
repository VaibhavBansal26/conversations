#!/usr/bin/env bash
# Second half of the measurement suite (the ramp, fault and dataset runs were done separately): scale-out 1/2/4 nodes with constant per-node load,
# room-size curve, reconnect storm, slow consumers, idempotency, REST, drain and a 30-minute soak. Each waits for a quiet machine.
set -u
cd "$(dirname "$0")"
mkdir -p results
Q="--quiet-load ${QUIET_LOAD:-14} --quiet-wait ${QUIET_WAIT:-1800}"
run() { name=$1; out=$2; shift 2; echo "=== $name -> $out ($(date +%T), load $(sysctl -n vm.loadavg))"; node run.mjs "$name" "$@" $Q --out "results/$out.json" > "results/$out.log" 2>&1; node summary.mjs "results/$out.json" | cut -c1-400 | head -12; }

# scale-out: per-node load constant (150 msg/s and 2000 visitor sockets per node), shared Redis + real PostgreSQL
run multinode scaleout-1node  --nodes 1 --db postgres --redis true --conns 2000 --agents 4 --rate 150 --duration 60 --workers 3
run multinode scaleout-2node  --nodes 2 --db postgres --redis true --conns 4000 --agents 4 --rate 300 --duration 60 --workers 4
run multinode scaleout-4node  --nodes 4 --db postgres --redis true --conns 8000 --agents 4 --rate 600 --duration 60 --workers 6
run roomsize  roomsize        --nodes 1 --db postgres --redis false --rate 50 --duration 20 --workers 4 --sizes 1,10,100,1000
run storm     storm-4node     --nodes 4 --conns 6000 --agents 2 --rate 200 --workers 6 --connect-rate 700
run slow      slow-2node      --nodes 2 --conns 1000 --agents 6 --rate 150 --duration 30 --workers 2
run idempotency idem-3node    --nodes 3
run rest      rest-pg         --nodes 1 --db postgres --redis false --conns 2000 --connections 64 --duration 10
run rest      rest-sqlite     --nodes 1 --db sqlite --redis false --conns 2000 --connections 64 --duration 10
run drain     drain-2node     --nodes 2 --conns 1000 --agents 2 --rate 100 --workers 2
node hotroom.mjs --writers 1,10,100,1000 --seconds 8 --out results/hotroom.json > results/hotroom.log 2>&1
run soak      soak-30min      --nodes 2 --conns 3000 --agents 3 --rate 100 --duration 1800 --workers 3
echo "suite2 done $(date +%T)"
