SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

IMG ?= swarmforge-tong-git-signing:latest

.PHONY: build test test-e2e image publish clean

# The touch stops make re-running this on every target.
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

# Multi-arch push; needs `docker login` and a multi-platform buildx builder.
# REPO must come from the command line so a stray exported REPO is never used.
TAGS ?= latest
PLATFORMS ?= linux/amd64,linux/arm64

publish:
	@if [ "$(origin REPO)" != "command line" ] || [ -z "$(REPO)" ]; then \
		echo "publish: pass REPO=<namespace>/<repository> on the command line" >&2; exit 1; \
	fi
	docker buildx build --platform $(PLATFORMS) $(foreach t,$(TAGS),--tag $(REPO):$(t)) --push .

clean:
	rm -rf dist node_modules
