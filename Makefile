SHELL := /bin/bash
.SHELLFLAGS := -euo pipefail -c

# A tong directory is any top-level directory holding a `*.tong.yaml`.
ALL_TONGS := $(sort $(patsubst %/,%,$(dir $(wildcard */*.tong.yaml))))

ifdef TONG
ifeq ($(filter $(TONG),$(ALL_TONGS)),)
$(error unknown TONG '$(TONG)'; known tongs: $(if $(ALL_TONGS),$(ALL_TONGS),<none>))
endif
TONGS := $(TONG)
else
TONGS := $(ALL_TONGS)
endif

# Delegate one target into every selected tong directory. Each tong owns its own
# Makefile; this file never learns a tong's build system.
define recurse
	@if [ -z "$(TONGS)" ]; then echo "no tongs found (looked for */*.tong.yaml)"; fi
	@for tong in $(TONGS); do \
		printf '\n==> %s: %s\n' "$$tong" "$(1)"; \
		$(MAKE) --no-print-directory -C "$$tong" $(1); \
	done
endef

.PHONY: help build test image images clean list

help:
	@echo "Swarmforge tongs — one top-level directory per standalone tong."
	@echo
	@echo "  make list                 show discovered tongs"
	@echo "  make build                compile every tong"
	@echo "  make test                 test every tong"
	@echo "  make images               docker build every tong image"
	@echo "  make clean                remove every tong's build output"
	@echo
	@echo "Scope any target to one tong with TONG=<dir-name>, e.g."
	@echo "  make test TONG=git-signing"
	@echo
	@echo "Each tong's Makefile also works on its own: cd <tong> && make test"

list:
	@if [ -z "$(ALL_TONGS)" ]; then echo "no tongs found (looked for */*.tong.yaml)"; else \
		for tong in $(ALL_TONGS); do echo "$$tong"; done; \
	fi

build:
	$(call recurse,build)

test:
	$(call recurse,test)

# `images` is the plural convenience name; the per-tong target is `image`.
image images:
	$(call recurse,image)

clean:
	$(call recurse,clean)
