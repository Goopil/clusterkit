#!/bin/bash
# Start all example servers in parallel, each on its own ports.
#
# App ports:     3000 (express) · 3001 (fastify) · 3005 (hono)
#                3006 (koa)     · 3007 (nestjs-express) · 3008 (nestjs-fastify)
# Metrics ports: 9090–9095 (sequential, one per app)

set -e

cleanup() {
  echo "Shutting down all examples..."
  kill 0 2>/dev/null
  wait
}
trap cleanup SIGTERM SIGINT

PORT=3000 METRICS_PORT=9090 node examples/express/src/index.mjs &
PORT=3001 METRICS_PORT=9091 node examples/fastify/src/index.mjs &
PORT=3005 METRICS_PORT=9092 node examples/hono/src/index.mjs &
PORT=3006 METRICS_PORT=9093 node examples/koa/src/index.mjs &
PORT=3007 METRICS_PORT=9094 node examples/nestjs-express/dist/main.js &
PORT=3008 METRICS_PORT=9095 node examples/nestjs-fastify/dist/main.js &

# Exit as soon as any process exits (propagates crashes to Docker)
wait -n
EXIT_CODE=$?
cleanup
exit $EXIT_CODE
