#!/usr/bin/env bash
# Micro-benchmarks that need a quiet machine: run after suite3.sh has finished. Uses a throwaway Redis on a random port and the embedded PostgreSQL.
cd "$(dirname "$0")/../server"
while pgrep -f suite3.sh >/dev/null; do sleep 20; done
PORT=$((20000 + RANDOM % 20000))
redis-server --port $PORT --save "" --daemonize yes --dir /tmp >/dev/null
sleep 1
npx tsx bench/limiter.ts --redis redis://127.0.0.1:$PORT --n 200000 > ../loadtest/results/bench-limiter.json 2> ../loadtest/results/bench-limiter.log
redis-cli -p $PORT shutdown nosave
npx tsx bench/rollup.ts --n 1000000 > ../loadtest/results/bench-rollup.json 2> ../loadtest/results/bench-rollup.log
echo done > ../loadtest/results/bench-after.done
