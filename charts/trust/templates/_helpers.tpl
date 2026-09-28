{{- define "trust.name" -}}
{{- default .Chart.Name .Values.nameOverride | trunc 63 | trimSuffix "-" -}}
{{- end -}}
{{- define "trust.fullname" -}}
{{- default (printf "%s-%s" .Release.Name (include "trust.name" .)) .Values.fullnameOverride | trunc 54 | trimSuffix "-" -}}
{{- end -}}
{{- define "trust.selectorLabels" -}}
app.kubernetes.io/name: {{ include "trust.name" . }}
app.kubernetes.io/instance: {{ .Release.Name }}
{{- end -}}
{{- define "trust.labels" -}}
{{ include "trust.selectorLabels" . }}
app.kubernetes.io/version: {{ .Chart.AppVersion | quote }}
app.kubernetes.io/managed-by: {{ .Release.Service }}
helm.sh/chart: {{ printf "%s-%s" .Chart.Name .Chart.Version | quote }}
{{- end -}}
{{- define "trust.claim" -}}
{{- default (printf "%s-state" (include "trust.fullname" .)) .Values.persistence.existingClaim -}}
{{- end -}}
{{- define "trust.validate" -}}
{{- if ne (int .Values.replicaCount) 1 }}{{ fail "TRUST requires replicaCount=1: exactly one runtime owns each database" }}{{ end -}}
{{- if ne .Values.config.server.host "0.0.0.0" }}{{ fail "config.server.host must be 0.0.0.0 inside the Pod" }}{{ end -}}
{{- if eq (int .Values.config.server.port) (int .Values.config.server.webPort) }}{{ fail "Runtime and web ports must differ" }}{{ end -}}
{{- if lt (int .Values.config.server.port) 1 }}{{ fail "The server runtime port must be a fixed positive port" }}{{ end -}}
{{- if ne .Values.config.server.stateDirectory "/var/lib/trust" }}{{ fail "config.server.stateDirectory must use the persistent /var/lib/trust mount" }}{{ end -}}
{{- if hasKey .Values.config.storage "connectionString" }}{{ fail "Use secretEnvironment for TRUST_DATABASE_URL; never put credentials in config" }}{{ end -}}
{{- if hasKey (.Values.config.shell | default dict) "webAccessPassword" }}{{ fail "Shared authentication cannot use a Basic web access password" }}{{ end -}}
{{- if not (has .Values.config.authentication.profile (list "shared" "fixed")) }}{{ fail "The chart requires shared or explicitly configured fixed authentication" }}{{ end -}}
{{- if eq .Values.config.authentication.profile "fixed" -}}
{{- if ne .Values.config.authentication.access.mode "fixed" }}{{ fail "Fixed authentication requires fixed access" }}{{ end -}}
{{- range $key, $_ := .Values.config.authentication -}}
{{- if not (has $key (list "profile" "access")) }}{{ fail "Fixed authentication accepts only profile and access; supply only the selected fixed identity settings" }}{{ end -}}
{{- end -}}
{{- else -}}
{{- if not (has (get (.Values.config.authentication.access | default dict) "mode") (list "local-jwt" "introspection")) }}{{ fail "Shared authentication requires explicit OIDC/OAuth access configuration; select examples/oidc-values.yaml or examples/fixed-values.yaml" }}{{ end -}}
{{- end -}}
{{- if eq .Values.config.authentication.access.mode "local" }}{{ fail "The chart refuses unauthenticated local mode" }}{{ end -}}
{{- $seen := dict -}}
{{- $mounts := dict -}}
{{- range .Values.configurationMounts -}}
{{- if hasKey $mounts .name }}{{ fail (printf "Duplicate configuration mount %s" .name) }}{{ end -}}
{{- $_ := set $mounts .name true -}}
{{- end -}}
{{- range $name, $value := .Values.environment -}}
{{- if or (has $name (list "TRUST_CONFIG_FILE" "TRUST_HOST" "TRUST_PORT" "TRUST_WEB_PORT" "TRUST_SERVER_STATE_DIRECTORY" "TRUST_INSTALL_ROOT" "TRUST_STORAGE" "TRUST_PGLITE_DIRECTORY" "TRUST_DATABASE_URL" "TRUST_AUTHENTICATION" "TRUST_AUTH_CONFIG_FILE" "TRUST_WEB_ACCESS_PASSWORD")) (regexMatch "(?i)(PASSWORD|SECRET|TOKEN)" $name) }}{{ fail (printf "environment.%s is secret-bearing or conflicts with chart-managed configuration" $name) }}{{ end -}}
{{- $_ := set $seen $name true -}}
{{- end -}}
{{- range .Values.secretEnvironment -}}
{{- if hasKey $seen .name }}{{ fail (printf "Duplicate environment variable %s" .name) }}{{ end -}}
{{- if has .name (list "TRUST_CONFIG_FILE" "TRUST_HOST" "TRUST_PORT" "TRUST_WEB_PORT" "TRUST_SERVER_STATE_DIRECTORY" "TRUST_INSTALL_ROOT" "TRUST_STORAGE" "TRUST_PGLITE_DIRECTORY" "TRUST_AUTHENTICATION" "TRUST_AUTH_CONFIG_FILE" "TRUST_WEB_ACCESS_PASSWORD") }}{{ fail (printf "secretEnvironment.%s conflicts with chart-managed configuration" .name) }}{{ end -}}
{{- $_ := set $seen .name true -}}
{{- end -}}
{{- if eq .Values.config.storage.kind "postgresql" -}}
{{- if not (hasKey $seen "TRUST_DATABASE_URL") }}{{ fail "PostgreSQL requires a TRUST_DATABASE_URL existing Secret reference" }}{{ end -}}
{{- else if eq .Values.config.storage.kind "pglite" -}}
{{- if ne .Values.config.storage.directory "/var/lib/trust/pglite" }}{{ fail "PGlite must use /var/lib/trust/pglite on the persistent state volume" }}{{ end -}}
{{- if hasKey $seen "TRUST_DATABASE_URL" }}{{ fail "Remove TRUST_DATABASE_URL when selecting PGlite" }}{{ end -}}
{{- else }}{{ fail "Unsupported storage kind" }}{{ end -}}
{{- end -}}
