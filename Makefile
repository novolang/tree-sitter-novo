# orbit/novo-treesitter/grammar/Makefile
#
# Builds the tree-sitter-novo grammar shared object.  Two-step:
#   1. `tree-sitter generate` rewrites src/parser.c from grammar.js
#      (only when grammar.js changed; src/parser.c is checked in
#      so consumers without tree-sitter-cli can build).
#   2. `cc -shared` produces tree-sitter-novo.so for dlopen by the
#      novo-treesitter CLI.
#
# `make generate` regenerates parser.c (developer task; needs
# tree-sitter-cli).  `make` (default) just compiles the existing
# parser.c — no Node.js / cargo toolchain needed.

CC      ?= cc
CFLAGS  ?= -O2 -Wall -fPIC

all: tree-sitter-novo.so

tree-sitter-novo.so: src/parser.c src/scanner.c
	$(CC) $(CFLAGS) -I src/ -shared -o $@ src/parser.c src/scanner.c

# Developer-only target — regenerates src/parser.c from grammar.js
# via `tree-sitter generate`.  Requires tree-sitter-cli on PATH.
#
# --abi 14 IS LOAD-BEARING.  A CLI from 0.25 on emits an ABI-15
# `TSLanguage` with four fields the system libtree-sitter this package
# links against does not know (`supertype_count`, `name`,
# `max_reserved_word_set_size`, `metadata`), and the runtime answers by
# refusing the language: every parse comes back
# `ts_parser_set_language failed (incompatible ABI?)` while the build
# and the CLI smoke tests stay green.  ABI 14 is understood by every
# runtime that understands 15, and the grammar uses no ABI-15 feature
# (no supertypes, no reserved-word sets).  Raise it when the runtime
# does — tests/run.sh's end-to-end parse is the check that notices.
TS_ABI ?= 14

generate: grammar.js
	tree-sitter generate --abi $(TS_ABI)

test: generate
	tree-sitter test

clean:
	rm -f tree-sitter-novo.so

.PHONY: all generate test clean
