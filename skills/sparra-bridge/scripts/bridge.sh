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
    build|reflect|init|freeze)
              _bridge_phase "$cmd" "$1" "${2:-}" ;;
    # plan: bridge plan <root> <plan-md-text>
    plan)     _bridge_need || return 1
              _bridge_post /plan "$(jq -cn --arg r "$1" --arg c "$2" '{root:$r,content:$c}')" ;;
    # conductor endpoints (sync -> summary): pass a full JSON body
    role|unit) _bridge_post "/$cmd" "$1" ;;
    # conduct: bridge conduct <root> <prompt> [--commit] [--merge] [extra-json] -> {jobId}.
    # Merges {root,prompt} with the optional self-landing flags (forwarded verbatim; the CLI owns
    # --merge => --commit) and any extra-json. The extra-json arg is OPTIONAL (defaults to {});
    # jq/body-construction failures are propagated (return 1) rather than sending a bodyless POST.
    conduct)  _bridge_need || return 1
              local croot="$1" cprompt="$2"; shift 2 2>/dev/null || true
              local ccommit=false cmerge=false cextra='{}' arg
              for arg in "$@"; do
                case "$arg" in
                  --commit) ccommit=true ;;
                  --merge)  cmerge=true ;;
                  *)        cextra="$arg" ;;
                esac
              done
              [ -n "$cextra" ] || cextra='{}'
              local cbody
              cbody=$(jq -cn --arg r "$croot" --arg p "$cprompt" \
                        --argjson commit "$ccommit" --argjson merge "$cmerge" --argjson x "$cextra" \
                        '{root:$r,prompt:$p}
                         + (if $commit then {commit:true} else {} end)
                         + (if $merge then {merge:true} else {} end)
                         + $x') || {
                echo "bridge conduct: invalid extra-json (must be a JSON object, e.g. '{\"budget\":5}')" >&2; return 1; }
              _bridge_post /conduct "$cbody" ;;
    # resume: bridge resume <root> <runId> [--commit] [--merge] [--auto] -> {jobId}.
    # Rides the SAME POST /conduct endpoint with a `resume` runId (continue a crashed/parked run in
    # place). ONLY resume-compatible flags are accepted (the server 400s a run-shaping field alongside
    # `resume`); an unknown arg is rejected before any request.
    resume)   _bridge_need || return 1
              local rroot="$1" rid="$2"; shift 2 2>/dev/null || true
              local rcommit=false rmerge=false rauto=false arg
              for arg in "$@"; do
                case "$arg" in
                  --commit) rcommit=true ;;
                  --merge)  rmerge=true ;;
                  --auto)   rauto=true ;;
                  *) echo "bridge resume: unknown arg '$arg' (expected --commit|--merge|--auto)" >&2; return 1 ;;
                esac
              done
              local rbody
              rbody=$(jq -cn --arg r "$rroot" --arg id "$rid" \
                        --argjson commit "$rcommit" --argjson merge "$rmerge" --argjson auto "$rauto" \
                        '{root:$r,resume:$id}
                         + (if $auto then {auto:true} else {} end)
                         + (if $commit then {commit:true} else {} end)
                         + (if $merge then {merge:true} else {} end)') || return 1
              _bridge_post /conduct "$rbody" ;;
    # decide: bridge decide <jobId> <seq> <answer> [note] -> answer a parked conduct decision.
    decide)   _bridge_need || return 1
              local dbody
              dbody=$(jq -cn --argjson s "$2" --arg a "$3" --arg n "${4:-}" '{seq:$s,answer:$a} + (if $n=="" then {} else {note:$n} end)') || return 1
              _bridge_post "/jobs/$1/decision" "$dbody" ;;
    # jobs -> GET /jobs: the tracked in-memory jobs (newest-first, no per-job log). Since bridge boot.
    jobs)     _bridge_get "/jobs" ;;
    job)      _bridge_get "/jobs/$1" ;;
    cancel)   _bridge_post "/jobs/$1/cancel" ;;
    # events [cursor] -> GET /events?since=<cursor>: cursor-delta job_started/job_done/decision_parked
    # feed across ALL jobs (default cursor 0 = everything retained). Save the response's `cursor` and
    # pass it back next call — cheaper than polling every job's `job <jobId>` individually.
    events)   _bridge_get "/events?since=${1:-0}" ;;
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
  build|reflect|init|freeze <root> [extra-json]   POST phase -> {jobId}
  plan <root> <plan-md-text>     POST /plan (needs allowRemotePlan)
  conduct <root> <prompt> [--commit] [--merge] [extra-json]   POST /conduct -> {jobId}
  resume <root> <runId> [--commit] [--merge] [--auto]         POST /conduct (continue a parked run) -> {jobId}
  decide <jobId> <seq> <answer> [note]   POST /jobs/:id/decision (answer a parked decision)
  role <json>                    POST /role  -> ParentSummary
  unit <json>                    POST /unit  -> UnitProjection
  jobs                           GET /jobs  (tracked jobs since bridge boot, newest-first, no log)
  job <jobId>                    GET /jobs/:id  (conduct jobs carry pendingDecisions)
  events [cursor=0]              GET /events?since=<cursor>  (job_started/job_done feed, ALL jobs)
  watch <jobId> [interval=5]     poll until terminal (exit 0 iff succeeded)
  cancel <jobId>                 POST /jobs/:id/cancel
env: SPARRA_BRIDGE_URL, SPARRA_BRIDGE_TOKEN
USAGE
      return 2 ;;
  esac
}

# Allow direct execution too: `bridge.sh build /abs/proj` behaves like the sourced function.
if [ "${BASH_SOURCE[0]}" = "$0" ]; then bridge "$@"; fi
