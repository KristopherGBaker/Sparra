# Sparra — developer tasks. Run `make` (or `make help`) to list targets.
MARKETPLACE  := sparra-skills
PLUGIN       := sparra@sparra-skills
BRIDGE_LABEL := com.sparra.bridge
BRIDGE_PLIST := $(HOME)/Library/LaunchAgents/$(BRIDGE_LABEL).plist

.DEFAULT_GOAL := help
.PHONY: help link setup-claude setup-codex setup-pi remove-pi \
	update-plugin update-codex-plugin \
	bridge-install bridge-update bridge-remove bridge-status bridge-logs bridge-token \
	typecheck test check

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-20s\033[0m %s\n", $$1, $$2}'

# ── One-time host setup ────────────────────────────────────────────────────────────────

link: ## npm install + npm link (exposes the `sparra` + `sparra-run-mcp` bins on PATH)
	npm install
	npm link

## Registration steps tolerate "already exists" so re-running is safe.
setup-claude: ## One-time Claude Code setup: sparra-run MCP + marketplace + plugin (/sparra-loop)
	-claude mcp add sparra-run --scope user -- sparra-run-mcp
	-claude plugin marketplace add "$(CURDIR)"
	claude plugin install $(PLUGIN)
	@echo "✓ Claude Code ready — open a project and type /sparra-loop."

setup-codex: ## One-time Codex setup: register this checkout as a marketplace + install the plugin
	-codex plugin marketplace add "$(CURDIR)"
	codex plugin add $(PLUGIN)
	@echo "✓ Codex ready — start a fresh thread in the target project and ask for sparra-loop."

## The Pi extension loads LIVE from this checkout (the install records the path), so there is
## no update step — `make setup-pi` once, then edits are picked up on the next Pi session.
setup-pi: ## One-time Pi setup: install the Pi conductor extension (loads live from this checkout)
	pi install ./conductors/pi
	@echo "✓ Pi ready — say \"conduct a Sparra loop …\" or /skill:sparra-loop."

remove-pi: ## Remove the Pi conductor extension
	pi remove ./conductors/pi

# ── Plugin refresh (after content changes) ─────────────────────────────────────────────

## Re-snapshot the installed Sparra plugin (skill + agents) from the COMMITTED repo,
## then remind you to restart. The directory marketplace caches a git commit, so commit
## (and land on the branch the marketplace resolves, i.e. main) BEFORE running this.
update-plugin: ## Refresh the installed sparra plugin/skills from the repo's committed state
	claude plugin marketplace update $(MARKETPLACE)
	claude plugin update $(PLUGIN)
	@echo "↻ Re-snapshotted. Start a FRESH Claude Code session to load the changes."

## A Codex plugin install is a cached snapshot keyed on .codex-plugin/plugin.json's
## semver-plus-cachebuster version — bump that version FIRST when .codex-plugin content
## changed, then reinstall. `remove` tolerates a not-installed plugin so the target is
## idempotent from a clean slate.
update-codex-plugin: ## Reinstall the sparra Codex plugin from this checkout (bump plugin.json's cachebuster first)
	-codex plugin remove $(PLUGIN)
	codex plugin add $(PLUGIN)
	@echo "↻ Reinstalled. Start a FRESH Codex thread to load the changes."

# ── HTTP bridge launchd service (macOS LaunchAgent) ────────────────────────────────────

## Two-step by design: the first run only copies the template (its token/paths are FAKE
## placeholders — loading it would give launchd a broken KeepAlive service to respawn
## forever). Edit the plist, then re-run to load. The placeholder guard keeps a
## half-edited plist from ever being loaded.
bridge-install: ## Install + load the bridge LaunchAgent (first run copies the plist template to edit)
	@if [ ! -f "$(BRIDGE_PLIST)" ]; then \
		cp conductors/http/com.sparra.bridge.plist.example "$(BRIDGE_PLIST)"; \
		echo "→ Copied template to $(BRIDGE_PLIST)"; \
		echo "  Edit EVERY placeholder (token — try 'make bridge-token' — node/bin paths,"; \
		echo "  working dir, bridge.yaml path, log paths), then re-run 'make bridge-install'."; \
	elif grep -q 'REPLACE_WITH\|/Users/example' "$(BRIDGE_PLIST)"; then \
		echo "✗ $(BRIDGE_PLIST) still contains template placeholders — edit it first."; exit 1; \
	else \
		launchctl load "$(BRIDGE_PLIST)"; \
		launchctl list | grep -q $(BRIDGE_LABEL) && echo "✓ $(BRIDGE_LABEL) loaded (make bridge-status / bridge-logs)"; \
	fi

bridge-update: ## Restart the bridge service (picks up new code/config — bins run the checkout live)
	launchctl unload "$(BRIDGE_PLIST)"
	launchctl load "$(BRIDGE_PLIST)"
	@launchctl list | grep -q $(BRIDGE_LABEL) && echo "↻ $(BRIDGE_LABEL) restarted."

bridge-remove: ## Unload the bridge service and delete its plist
	-launchctl unload "$(BRIDGE_PLIST)"
	rm -f "$(BRIDGE_PLIST)"
	@echo "✓ $(BRIDGE_LABEL) removed."

bridge-status: ## Show the bridge service's launchd status
	@launchctl list | grep $(BRIDGE_LABEL) || echo "$(BRIDGE_LABEL): not loaded"

bridge-logs: ## Tail the bridge's stdout/stderr logs (paths read from the installed plist)
	@out=$$(/usr/libexec/PlistBuddy -c 'Print StandardOutPath' "$(BRIDGE_PLIST)"); \
	err=$$(/usr/libexec/PlistBuddy -c 'Print StandardErrorPath' "$(BRIDGE_PLIST)"); \
	tail -f "$$out" "$$err"

bridge-token: ## Generate a bridge Bearer token (paste into the plist + your client env)
	@openssl rand -hex 32

# ── Quality gates ──────────────────────────────────────────────────────────────────────

typecheck: ## tsc --noEmit
	npm run typecheck

test: ## vitest run
	npm test

check: typecheck test ## typecheck + test (run before committing)
