#!/usr/bin/env bash
set -euo pipefail

ENVIRONMENT_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TRUST_PROJECTS_DIR="${TRUST_PROJECTS_DIR:-${ENVIRONMENT_ROOT}/projects}"
CLUSTER_NAME="${CLUSTER_NAME:-trust-test}"
IMAGE_TAG="${IMAGE_TAG:-}"
PAYMENT_COMMON_REVISION="${PAYMENT_COMMON_REVISION:-main}"
PAYMENT_API_REVISION="${PAYMENT_API_REVISION:-main}"
PAYMENT_WORKER_REVISION="${PAYMENT_WORKER_REVISION:-main}"
EVENT_STORE_REVISION="${EVENT_STORE_REVISION:-main}"
MAVEN_REPOSITORY="${MAVEN_REPOSITORY:-${HOME}/.m2/repository}"

DOCKER_DESKTOP_BIN="/Applications/Docker.app/Contents/Resources/bin"
if [[ -x "${DOCKER_DESKTOP_BIN}/docker-credential-osxkeychain" ]]; then
  export PATH="${DOCKER_DESKTOP_BIN}:${PATH}"
fi

BUILD_ROOT="$(mktemp -d "${TMPDIR:-/tmp}/trust-sample-revisions.XXXXXX")"
mkdir -p "${MAVEN_REPOSITORY}"
cleanup() {
  rm -rf "${BUILD_ROOT}"
}
trap cleanup EXIT

archive_project() {
  local project="$1"
  local revision="$2"
  local target="${BUILD_ROOT}/${project}"
  mkdir -p "${target}"
  git -C "${TRUST_PROJECTS_DIR}/${project}" archive "${revision}" | tar -x -C "${target}"
}

archive_project payment-common "${PAYMENT_COMMON_REVISION}"
archive_project payment-api "${PAYMENT_API_REVISION}"
archive_project payment-worker "${PAYMENT_WORKER_REVISION}"
archive_project event-store "${EVENT_STORE_REVISION}"

mvn -f "${BUILD_ROOT}/payment-common/pom.xml" -Dmaven.repo.local="${MAVEN_REPOSITORY}" -DskipTests clean install
for project in payment-api payment-worker event-store; do
  mvn -f "${BUILD_ROOT}/${project}/pom.xml" -Dmaven.repo.local="${MAVEN_REPOSITORY}" -DskipTests clean package
  revision_variable="$(printf '%s_REVISION' "${project//-/_}" | tr '[:lower:]' '[:upper:]')"
  revision="${!revision_variable}"
  tag="${IMAGE_TAG:-git-${revision:0:12}}"
  docker build \
    --label "org.opencontainers.image.revision=${revision}" \
    -t "trust/${project}:${tag}" \
    "${BUILD_ROOT}/${project}"
  kind load docker-image --name "${CLUSTER_NAME}" "trust/${project}:${tag}"
  image_id="$(docker image inspect "trust/${project}:${tag}" --format '{{.Id}}')"
  echo "Loaded trust/${project}:${tag} revision=${revision} imageId=${image_id}."
done

echo "Loaded exact sample revisions with immutable revision tags."
