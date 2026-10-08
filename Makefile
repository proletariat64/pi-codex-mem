# Development environment targets for this repository.
# bootstrap only touches this checkout (node_modules); it never edits global
# pi configuration, credentials, or the real memory store.

NODE_MIN_MAJOR := 22
NODE_MIN_MINOR := 19

.PHONY: help bootstrap node-check check typecheck test verify-upstream clean-dist

help:
	@echo "bootstrap        verify toolchain and install dependencies from package-lock.json"
	@echo "check            typecheck + tests + upstream verification"
	@echo "clean-dist       remove build/test residues (keeps node_modules)"

node-check:
	@command -v node >/dev/null 2>&1 || { echo "error: node not found (need >=$(NODE_MIN_MAJOR).$(NODE_MIN_MINOR))"; exit 1; }
	@command -v npm >/dev/null 2>&1 || { echo "error: npm not found"; exit 1; }
	@node -e 'const v=process.versions.node, [maj,min]=v.split(".").map(Number); if (maj < $(NODE_MIN_MAJOR) || (maj === $(NODE_MIN_MAJOR) && min < $(NODE_MIN_MINOR))) { console.error("error: node >= $(NODE_MIN_MAJOR).$(NODE_MIN_MINOR) required, found " + v); process.exit(1); } console.log("node " + v + " ok");'

bootstrap: node-check
	npm ci
	@echo "bootstrap complete: run 'make check' to verify."

typecheck:
	npm run typecheck

test:
	npm test

verify-upstream:
	npm run verify-upstream

check: typecheck test verify-upstream
	@echo "check complete."

clean-dist:
	@rm -rf .tmp 2>/dev/null || true
	@git status --short
