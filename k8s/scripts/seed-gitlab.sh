#!/usr/bin/env bash
set -euo pipefail

GITLAB_URL="${GITLAB_URL:-http://gitlab.127.0.0.1.nip.io}"
GITLAB_TOKEN="${GITLAB_TOKEN:-local-gitlab-token}"
GROUP_PATH="${GROUP_PATH:-trustgroup/trust-devs}"
GROUP_NAME="${GROUP_NAME:-Trust Devs}"

# Safety invariant: this provisioning script never reads or mutates a local Git repository and
# never pushes repository content. Branches, commits and merge requests belong to explicit
# developer or StateMachine workflows.

kubectl -n trust-test rollout status deployment/gitlab --timeout=900s

kubectl -n trust-test exec deploy/gitlab -- gitlab-rails runner "
ApplicationSetting.current.update!(auto_devops_enabled: false)
user = User.find_by_username('root')
token = user.personal_access_tokens.find_by(name: 'trust-kind')
unless token
  token = user.personal_access_tokens.build(name: 'trust-kind', scopes: [:api, :read_repository, :write_repository], expires_at: 1.year.from_now)
end
token.set_token('${GITLAB_TOKEN}')
token.save!

# TRUST OAuth application: public client (PKCE, no secret needed) with a fixed
# client id so environments can reference it declaratively; trusted skips the
# consent screen on this local instance.
app = Doorkeeper::Application.find_or_initialize_by(uid: 'trust-local')
app.name = 'TRUST local'
app.redirect_uri = \"http://127.0.0.1:8085/api/auth/callback\nhttp://localhost:8085/api/auth/callback\"
app.scopes = 'api'
app.confidential = false
app.trusted = true
app.save!
"

api() {
  curl --fail --silent --show-error --header "PRIVATE-TOKEN: ${GITLAB_TOKEN}" "$@"
}

group_parent="$(cut -d/ -f1 <<<"${GROUP_PATH}")"
group_child="$(cut -d/ -f2 <<<"${GROUP_PATH}")"

if ! api "${GITLAB_URL}/api/v4/groups/${group_parent}" >/dev/null 2>&1; then
  api --request POST "${GITLAB_URL}/api/v4/groups" \
    --form "name=Trust Group" \
    --form "path=${group_parent}" \
    --form "visibility=public" >/dev/null
fi

parent_id="$(api "${GITLAB_URL}/api/v4/groups/${group_parent}" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>console.log(JSON.parse(s).id));')"

encoded_group_path="$(node -e "console.log(encodeURIComponent('${GROUP_PATH}'))")"
if ! api "${GITLAB_URL}/api/v4/groups/${encoded_group_path}" >/dev/null 2>&1; then
  api --request POST "${GITLAB_URL}/api/v4/groups" \
    --form "name=${GROUP_NAME}" \
    --form "path=${group_child}" \
    --form "parent_id=${parent_id}" \
    --form "visibility=public" >/dev/null
fi

namespace_id="$(api "${GITLAB_URL}/api/v4/groups/${encoded_group_path}" | node -e 'let s=""; process.stdin.on("data",d=>s+=d); process.stdin.on("end",()=>console.log(JSON.parse(s).id));')"

for project in payment-common payment-api payment-worker event-store payment-acceptance; do
  encoded_path="$(node -e "console.log(encodeURIComponent('${GROUP_PATH}/${project}'))")"

  if ! api "${GITLAB_URL}/api/v4/projects/${encoded_path}" >/dev/null 2>&1; then
    api --request POST "${GITLAB_URL}/api/v4/projects" \
      --form "name=${project}" \
      --form "path=${project}" \
      --form "namespace_id=${namespace_id}" \
      --form "visibility=public" >/dev/null
  fi

  api --request PUT "${GITLAB_URL}/api/v4/projects/${encoded_path}" \
    --form "auto_devops_enabled=false" >/dev/null
done

echo "GitLab integration projects are provisioned; local repositories and Git content are untouched."
