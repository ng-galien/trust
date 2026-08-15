#!/usr/bin/env bash
set -euo pipefail

IMAGE_TAG="${1:?usage: set-sample-image-tag.sh <tag>}"
KUBE_CONTEXT="${KUBE_CONTEXT:-kind-trust-test}"

for project in payment-api payment-worker event-store; do
  kubectl --context "${KUBE_CONTEXT}" -n trust-test set image \
    "deployment/${project}" "${project}=trust/${project}:${IMAGE_TAG}"
done

for project in payment-api payment-worker event-store; do
  kubectl --context "${KUBE_CONTEXT}" -n trust-test rollout status \
    "deployment/${project}" --timeout=180s
done

echo "Sample services now run image tag ${IMAGE_TAG}."
