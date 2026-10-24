SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

IMG ?= swarmforge-tong-github:latest

.PHONY: build test image publish clean

# The touch stops make re-running this on every target.
node_modules: package.json
	@if [ -f package-lock.json ]; then npm ci; else npm install; fi
	@touch node_modules

build: node_modules
	npm run build

# No docker, no token, no network.
test: node_modules
	npm test

image:
	docker build -t $(IMG) .

# Needs `docker login` and a multi-platform buildx builder.
# REPO from the environment is refused, so a stray export cannot redirect a bare `make publish`.
TAGS ?= latest
PLATFORMS ?= linux/amd64,linux/arm64

publish:
	@if [ "$(origin REPO)" != "command line" ] || [ -z "$(REPO)" ]; then \
		echo "publish: pass REPO=<namespace>/<repository> on the command line" >&2; exit 1; \
	fi
	docker buildx build --platform $(PLATFORMS) $(foreach t,$(TAGS),--tag $(REPO):$(t)) --push .

clean:
	rm -rf dist node_modules
