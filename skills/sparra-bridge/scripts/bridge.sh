#!/usr/bin/env bash
# bridge.sh — a thin client for the Sparra HTTP bridge (conductors/http).
#
#   source skills/sparra-bridge/scripts/bridge.sh
#   export SPARRA_BRIDGE_URL="http://100.x.y.z:8787"   # host tailnet address:port
#   export SPARRA_BRIDGE_TOKEN="…"                       # shared Bearer token
#   bridge health
#   bridge projects
#   ID=$(bridge build /abs/proj '{"budget":5}' | jq -r .jobId); bridge watch "$ID"
#   bridge role '{"workspace":"/abs/proj","kind":"evaluator","contractPath":"…","worktree":true}'
#
# All output is the raw JSON response (pipe through jq). Every call except health/projects that
# targets a project takes the root/workspace inside its JSON body. Requires curl + jq.

_bridge_need() {
  [ -n "$SPARRA_BRIDGE_URL" ]   || { echo "bridge: set SPARRA_BRIDGE_URL (e.g. http://100.x.y.z:8787)" >&2; return 1; }
  [ -n "$SPARRA_BRIDGE_TOKEN" ] || { echo "bridge: set SPARRA_BRIDGE_TOKEN" >&2; return 1; }
  command -v jq >/dev/null      || { echo "bridge: jq is required" >&2; return 1; }
}

# _bridge_get <path>
_bridge_get() {
  _bridge_need || return 1
  curl -fsS -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" "$SPARRA_BRIDGE_URL$1"
}

# _bridge_post <path> [json-body]
_bridge_post() {
  _bridge_need || return 1
  local path="$1"; shift
  local body="${1:-}"
  if [ -n "$body" ]; then
    curl -fsS -X POST -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" \
      -H "Content-Type: application/json" -d "$body" "$SPARRA_BRIDGE_URL$path"
  else
    curl -fsS -X POST -H "Authorization: Bearer $SPARRA_BRIDGE_TOKEN" "$SPARRA_BRIDGE_URL$path"
  fi
}

# _bridge_phase <endpoint> <root> [extra-json] — merges {"root":...} with any extra fields.
_bridge_phase() {
  _bridge_need || return 1
  local ep="$1" root="$2" extra="${3:-{\}}"
  local body
  body=$(jq -cn --arg root "$root" --argjson extra "$extra" '{root:$root} + $extra') || return 1
  _bridge_post "/$ep" "$body"
}

bridge() {
  local cmd="${1:-}"; shift 2>/dev/null || true
  case "$cmd" in
    health)   curl -fsS "$SPARRA_BRIDGE_URL/health" ;;              # no token needed
    projects) _bridge_get "/projects" ;;
    # phase triggers (async -> {jobId}): bridge build <root> [extra-json]
    build|reflect|resume|init|freeze)
              _bridge_phase "$cmd" "$1" "${2:-}" ;;
    # plan: bridge plan <root> <plan-md-text>
    plan)     _bridge_need || return 1
              _bridge_post /plan "$(jq -cn --arg r "$1" --arg c "$2" '{root:$r,content:$c}')" ;;
    # conductor endpoints (sync -> summary): pass a full JSON body
    role|unit) _bridge_post "/$cmd" "$1" ;;
    job)      _bridge_get "/jobs/$1" ;;
    cancel)   _bridge_post "/jobs/$1/cancel" ;;
    # watch <jobId> [interval] — poll until the job leaves "running", print status+exitCode.
    watch)
      _bridge_need || return 1
      local id="$1" iv="${2:-5}" j s
      [ -n "$id" ] || { echo "bridge watch <jobId>" >&2; return 1; }
      while :; do
        j=$(_bridge_get "/jobs/$id") || return 1
        s=$(jq -r '.status' <<<"$j")
        if [ "$s" != running ]; then
          jq '{id,kind,status,exitCode}' <<<"$j"
          [ "$s" = succeeded ]; return                     # exit 0 iff succeeded
        fi
        sleep "$iv"
      done ;;
    *)
      cat >&2 <<'USAGE'
bridge <command>
  health                         GET /health (no token)
  projects                       GET /projects
  build|reflect|resume|init|freeze <root> [extra-json]   POST phase -> {jobId}
  plan <root> <plan-md-text>     POST /plan (needs allowRemotePlan)
  role <json>                    POST /role  -> ParentSummary
  unit <json>                    POST /unit  -> UnitProjection
  job <jobId>                    GET /jobs/:id
  watch <jobId> [interval=5]     poll until terminal (exit 0 iff succeeded)
  cancel <jobId>                 POST /jobs/:id/cancel
env: SPARRA_BRIDGE_URL, SPARRA_BRIDGE_TOKEN
USAGE
      return 2 ;;
  esac
}

# Allow direct execution too: `bridge.sh build /abs/proj` behaves like the sourced function.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then bridge "$@"; fi
