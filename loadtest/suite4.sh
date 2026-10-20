#!/usr/bin/env bash
# Re-run of the load-sensitive scenarios in a quiet window (starts only after suite3 and bench-after have finished; each scenario also waits for load < 10).
# Scale-out: constant load PER VISITOR NODE (750 sockets, 30 msg/s) while the number of visitor nodes grows 2 -> 3 -> 4 (nodes = visitor nodes + 1 agent node).
cd "$(dirname "$0")"
while pgrep -f "suite3.sh|bench-after.sh" >/dev/null; do sleep 20; done
Q="--quiet-load ${QUIET_LOAD:-10} --quiet-wait ${QUIET_WAIT:-900}"
run() { name=$1; out=$2; shift 2; echo "=== $name -> $out ($(date +%T), load $(sysctl -n vm.loadavg))"; node run.mjs "$name" "$@" $Q --out "results/$out.json" > "results/$out.log" 2>&1; [ -f "results/$out.json" ] && node summary.mjs "results/$out.json" | grep -v "^server" | cut -c1-500 | head -6; }
run multinode scaleout-3node --nodes 3 --db postgres --redis true --conns 1500 --agents 4 --rate 60  --duration 45 --workers 3
run multinode scaleout-4node --nodes 4 --db postgres --redis true --conns 2250 --agents 4 --rate 90  --duration 45 --workers 3
run multinode scaleout-5node --nodes 5 --db postgres --redis true --conns 3000 --agents 4 --rate 120 --duration 45 --workers 4
run storm storm-3node --nodes 3 --conns 2000 --agents 2 --rate 100 --workers 3 --connect-rate 400
run rest rest-pg --nodes 1 --db postgres --redis false --conns 500 --connections 32 --duration 10
node hotroom.mjs --writers 1,10,100,1000 --seconds 8 --out results/hotroom.json > results/hotroom.log 2>&1
run roomsize roomsize --nodes 1 --db postgres --redis false --rate 40 --duration 15 --workers 3 --sizes 1,10,100,1000 --conns 50
echo "suite4 done $(date +%T)"
