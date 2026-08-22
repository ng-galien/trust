#!/usr/bin/env bash
set -euo pipefail

GITLAB_URL="${GITLAB_URL:-http://gitlab.127.0.0.1.nip.io}"
GITLAB_TOKEN="${GITLAB_TOKEN:-local-gitlab-token}"
GROUP_PATH="${GROUP_PATH:-trustgroup/trust-devs}"
JENKINS_WEBHOOK_BASE_URL="${JENKINS_WEBHOOK_BASE_URL:-http://jenkins.trust-test.svc.cluster.local:8080}"

api() {
  curl --fail --silent --show-error --header "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "$@"
}

urlencode() {
  node -e "console.log(encodeURIComponent(process.argv[1]))" "$1"
}

kubectl -n trust-test rollout status deployment/gitlab --timeout=900s
kubectl -n trust-test exec deploy/gitlab -- gitlab-rails runner "
ApplicationSetting.current.update!(
  allow_local_requests_from_web_hooks_and_services: true,
  allow_local_requests_from_system_hooks: true
)
"

for project in payment-common payment-api payment-worker event-store payment-acceptance; do
  encoded_path="$(urlencode "${GROUP_PATH}/${project}")"

  api "${GITLAB_URL}/api/v4/projects/${encoded_path}/hooks" |
    node -e "let s=''; process.stdin.on('data', d => s += d); process.stdin.on('end', () => JSON.parse(s).filter(h => h.url.includes('jenkins.trust-test.svc.cluster.local')).forEach(h => console.log(h.id)))" |
    while IFS= read -r hook_id; do
      [[ -n "${hook_id}" ]] || continue
      api --request DELETE "${GITLAB_URL}/api/v4/projects/${encoded_path}/hooks/${hook_id}" >/dev/null
    done

  repository_url="http://gitlab.trust-test.svc.cluster.local/${GROUP_PATH}/${project}.git"
  encoded_repository_url="$(urlencode "${repository_url}")"
  hook_url="${JENKINS_WEBHOOK_BASE_URL}/git/notifyCommit?url=${encoded_repository_url}"
  api --request POST "${GITLAB_URL}/api/v4/projects/${encoded_path}/hooks" \
    --form "url=${hook_url}" \
    --form "push_events=true" \
    --form "merge_requests_events=false" \
    --form "tag_push_events=false" \
    --form "enable_ssl_verification=false" >/dev/null

  echo "Wired ${GROUP_PATH}/${project} -> Jenkins multibranch scan"
done

echo "GitLab push hooks are wired to Jenkins."
