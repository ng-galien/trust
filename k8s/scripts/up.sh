#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
CLUSTER_NAME="${CLUSTER_NAME:-trust-test}"
PROFILE="${1:-integration}"
INGRESS_NGINX_VERSION="${INGRESS_NGINX_VERSION:-controller-v1.13.3}"
INGRESS_NGINX_MANIFEST="https://raw.githubusercontent.com/kubernetes/ingress-nginx/${INGRESS_NGINX_VERSION}/deploy/static/provider/kind/deploy.yaml"
KUSTOMIZE_DIR="${ROOT_DIR}/k8s/k8s"
EXTRA_MANIFESTS=()

if [[ "${PROFILE}" == "integration" ]]; then
  EXTRA_MANIFESTS=(
    "${ROOT_DIR}/k8s/k8s/integration/connectors.yaml"
    "${ROOT_DIR}/k8s/k8s/integration/connector-ingress.yaml"
  )
else
  echo "Unknown Kind test environment profile: ${PROFILE}" >&2
  echo "Usage: k8s/scripts/up.sh [integration]" >&2
  exit 2
fi

if ! kind get clusters | grep -qx "${CLUSTER_NAME}"; then
  kind create cluster --config "${ROOT_DIR}/k8s/cluster/kind-config.yaml"
fi

if ! kubectl get ingressclass nginx >/dev/null 2>&1; then
  kubectl apply -f "${INGRESS_NGINX_MANIFEST}"
fi

kubectl -n ingress-nginx rollout status deployment/ingress-nginx-controller --timeout=180s

apply_with_ingress_retry() {
  local attempt
  for attempt in 1 2 3 4 5; do
    if kubectl apply "$@"; then
      return 0
    fi
    if [[ "${attempt}" -eq 5 ]]; then
      echo "Failed to apply manifests after ${attempt} attempts." >&2
      return 1
    fi
    echo "Ingress admission is not ready yet; retrying manifest apply (${attempt}/5)..." >&2
    sleep 3
  done
}

apply_with_ingress_retry -k "${KUSTOMIZE_DIR}"
if [[ "${#EXTRA_MANIFESTS[@]}" -gt 0 ]]; then
  for manifest in "${EXTRA_MANIFESTS[@]}"; do
    apply_with_ingress_retry -f "${manifest}"
  done
fi

echo "Kind test environment profile '${PROFILE}' is applied."
echo "Build sample services with: k8s/scripts/build-samples.sh"
echo "Build integration connectors with: k8s/scripts/build-connectors.sh"
echo "Ingress endpoints use:     http://*.127.0.0.1.nip.io"
echo "Port-forward fallback:     k8s/scripts/port-forward.sh"
