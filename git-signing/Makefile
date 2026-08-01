SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

IMG ?= swarmforge-tong-git-signing:latest

.PHONY: build test test-e2e image clean

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

clean:
	rm -rf dist node_modules
