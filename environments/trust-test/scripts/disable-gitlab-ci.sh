#!/usr/bin/env bash
set -euo pipefail

GITLAB_URL="${GITLAB_URL:-http://gitlab.127.0.0.1.nip.io}"
GITLAB_TOKEN="${GITLAB_TOKEN:-local-gitlab-token}"
GROUP_PATH="${GROUP_PATH:-trustgroup/trust-devs}"
PRUNE_GITLAB_PIPELINES="${PRUNE_GITLAB_PIPELINES:-true}"

projects=(payment-common payment-api payment-worker event-store payment-acceptance kind-test)

kubectl -n trust-test rollout status deployment/gitlab --timeout=900s

kubectl -n trust-test exec deploy/gitlab -- gitlab-rails runner \
  "ApplicationSetting.current.update!(auto_devops_enabled: false)"

api() {
  curl --fail --silent --show-error --header "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "$@"
}

for project in "${projects[@]}"; do
  encoded_path="$(node -e "console.log(encodeURIComponent('${GROUP_PATH}/${project}'))")"
  api --request PUT "${GITLAB_URL}/api/v4/projects/${encoded_path}" \
    --form "auto_devops_enabled=false" >/dev/null

  if [[ "${PRUNE_GITLAB_PIPELINES}" == "true" ]]; then
    pipeline_ids="$(
      api "${GITLAB_URL}/api/v4/projects/${encoded_path}/pipelines?per_page=100" |
        node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => JSON.parse(s).forEach(p => console.log(p.id)));"
    )"
    while IFS= read -r pipeline_id; do
      [[ -z "${pipeline_id}" ]] && continue
      api --request DELETE "${GITLAB_URL}/api/v4/projects/${encoded_path}/pipelines/${pipeline_id}" >/dev/null || true
    done <<<"${pipeline_ids}"
  fi
done

echo "GitLab CI pipelines are disabled for the test environment projects."
