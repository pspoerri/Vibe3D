# Thin wrappers over the pnpm scripts, plus the one thing they lack: installing
# the skill. SKILL_DIR=/path make install-skill puts it somewhere else.
SKILL_DIR ?= $(HOME)/.claude/skills/vibe3d
# ponytail: mirrors findChrome in skills/vibe3d/cli.ts — keep the two lists the same.
CHROME_NAMES = google-chrome google-chrome-stable chromium chromium-browser chrome
CHROME_APPS = "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" "/Applications/Chromium.app/Contents/MacOS/Chromium"

.PHONY: install dev build test e2e eval skill doctor install-skill clean

install:
	pnpm install

dev:
	pnpm dev

build:
	pnpm build

test:
	pnpm test

e2e:
	pnpm e2e

eval:
	pnpm eval

skill:
	pnpm build:skill

# What the installed skill needs: bun always, Chrome only for `look`.
doctor:
	@command -v bun >/dev/null || { echo "bun not found: brew install oven-sh/bun/bun"; exit 1; }
	@echo "bun $$(bun --version)"
	@chrome="$(VIBE3D_CHROME)"; \
	for n in $(CHROME_NAMES); do [ -n "$$chrome" ] || chrome=$$(command -v $$n); done; \
	for a in $(CHROME_APPS); do [ -n "$$chrome" ] || [ ! -x "$$a" ] || chrome="$$a"; done; \
	if [ -n "$$chrome" ]; then echo "chrome $$chrome"; else echo "no Chrome found: look will not work until VIBE3D_CHROME names one"; fi

# A copy, not a link: the skill runs where it lands, repo or no repo.
install-skill: doctor skill
	rm -rf "$(SKILL_DIR)"
	mkdir -p "$(dir $(SKILL_DIR))"
	cp -r dist/skill "$(SKILL_DIR)"
	@echo "installed $(SKILL_DIR)"

clean:
	rm -rf dist
