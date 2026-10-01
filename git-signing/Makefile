SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

IMG ?= swarmforge-tong-git-signing:latest

.PHONY: build test test-e2e image publish clean

# `npm ci` needs a lockfile, so a clone without one falls back to `npm install`.
# The touch is what stops make re-running this on every target.
node_modules: package.json
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi
	@touch node_modules

build: node_modules
	npm run build

# No docker, no gpg, no real key.
test: node_modules
	npm test

# Needs `git` and `gpg` on PATH.
test-e2e: node_modules
	npm run test:e2e

image:
	docker build -t $(IMG) .

# Multi-arch build pushed straight to a registry; nothing is loaded locally.
# Needs `docker login` and a buildx builder that can target every platform in
# PLATFORMS, both of which CI sets up. REPO has no default, so a bare
# `make publish` refuses rather than pushing somewhere by accident.
REPO ?=
TAGS ?= latest
PLATFORMS ?= linux/amd64,linux/arm64

publish:
	@if [ -z "$(REPO)" ]; then echo "publish: set REPO=<namespace>/<repository>" >&2; exit 1; fi
	docker buildx build --platform $(PLATFORMS) $(foreach t,$(TAGS),--tag $(REPO):$(t)) --push .

clean:
	rm -rf dist node_modules
