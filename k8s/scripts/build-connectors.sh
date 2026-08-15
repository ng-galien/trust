#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-trust-test}"

docker build -t trust/jira-mock:local "${ROOT_DIR}/k8s/connectors/jira-mock"
docker build -t trust/jenkins-test:local "${ROOT_DIR}/k8s/connectors/jenkins"

kind load docker-image --name "${CLUSTER_NAME}" trust/jira-mock:local
kind load docker-image --name "${CLUSTER_NAME}" trust/jenkins-test:local

kubectl -n trust-test rollout restart deployment/jira-mock deployment/jenkins
kubectl -n trust-test rollout status deployment/jira-mock --timeout=180s
kubectl -n trust-test rollout status deployment/jenkins --timeout=300s
