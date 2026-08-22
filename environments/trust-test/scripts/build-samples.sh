#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRUST_PROJECTS_DIR="${TRUST_PROJECTS_DIR:-${ENVIRONMENT_ROOT}/projects}"
CLUSTER_NAME="${CLUSTER_NAME:-trust-test}"
PROJECTS=(payment-api payment-worker event-store)

(
  cd "${TRUST_PROJECTS_DIR}/payment-common"
  mvn -DskipTests clean install
)
for project in "${PROJECTS[@]}"; do
  mvn -f "${TRUST_PROJECTS_DIR}/${project}/pom.xml" -DskipTests clean package
done

docker build -t trust/payment-api:dev "${TRUST_PROJECTS_DIR}/payment-api"
docker build -t trust/payment-worker:dev "${TRUST_PROJECTS_DIR}/payment-worker"
docker build -t trust/event-store:dev "${TRUST_PROJECTS_DIR}/event-store"

kind load docker-image --name "${CLUSTER_NAME}" trust/payment-api:dev
kind load docker-image --name "${CLUSTER_NAME}" trust/payment-worker:dev
kind load docker-image --name "${CLUSTER_NAME}" trust/event-store:dev

kubectl -n trust-test rollout restart deployment/payment-api deployment/payment-worker deployment/event-store
kubectl -n trust-test rollout status deployment/payment-api
kubectl -n trust-test rollout status deployment/payment-worker
kubectl -n trust-test rollout status deployment/event-store
