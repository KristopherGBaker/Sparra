# Sparra — developer tasks. Run `make` (or `make help`) to list targets.
MARKETPLACE := sparra-skills
PLUGIN      := sparra@sparra-skills

.DEFAULT_GOAL := help
.PHONY: help update-plugin update-codex-plugin typecheck test check

help: ## List available targets
	@grep -E '^[a-zA-Z_-]+:.*?## ' $(MAKEFILE_LIST) | \
		awk 'BEGIN{FS=":.*?## "}{printf "  \033[36m%-14s\033[0m %s\n", $$1, $$2}'

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

typecheck: ## tsc --noEmit
	npm run typecheck

test: ## vitest run
	npm test

check: typecheck test ## typecheck + test (run before committing)
