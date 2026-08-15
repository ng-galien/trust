#!/usr/bin/env bash
set -euo pipefail

kubectl -n trust-test port-forward svc/payment-api 18080:8080 &
kubectl -n trust-test port-forward svc/payment-worker 18081:8080 &
kubectl -n trust-test port-forward svc/event-store 18082:8080 &
kubectl -n trust-test port-forward svc/pulsar 16650:6650 &
kubectl -n trust-test port-forward svc/pulsar 18085:8080 &
kubectl -n telemetry port-forward svc/tempo 3200:3200 &

echo "Port forwards started in background:"
echo "  payment-api    http://127.0.0.1:18080"
echo "  payment-worker http://127.0.0.1:18081"
echo "  event-store    http://127.0.0.1:18082"
echo "  pulsar broker  pulsar://127.0.0.1:16650"
echo "  pulsar admin   http://127.0.0.1:18085"
echo "  tempo          http://127.0.0.1:3200"
wait
