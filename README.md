# tree-sitter-novo

A [tree-sitter](https://tree-sitter.github.io) grammar for
[novo-lang](https://novo-lang.org) — the parser behind editor
highlighting, folds, text objects and structural navigation.

This is a **second** parser for the language, and deliberately so. The
compiler's parser rejects code that does not compile; an editor has to
keep parsing while you are halfway through typing a line. The two will
never share an implementation, which is why the novo repository carries
an audit holding this grammar against the compiler's keyword table.

## Using it

### Neovim

Install [novo.nvim](https://github.com/novolang/novo.nvim), which ships
the queries and points nvim-treesitter here for the parser.

### Anything else

```sh
git clone https://github.com/novolang/tree-sitter-novo
cd tree-sitter-novo
tree-sitter generate && tree-sitter test
```

The queries under `queries/` are neovim-flavoured capture names.

## Layout

| path | what it is |
|---|---|
| `grammar.js` | the grammar — the only file to edit by hand |
| `src/parser.c`, `src/scanner.c` | generated; regenerate, never edit |
| `queries/` | highlights, folds, indents, locals, textobjects |
| `test/corpus/` | 131 parse assertions, run by `tree-sitter test` |

`scanner.c` is not optional. Novo is indentation-based and the external
scanner is what emits `INDENT`, `DEDENT` and `NEWLINE`; a parser built
from `parser.c` alone links, loads, and then fails on any file
containing a block.

## Changing the grammar

Edit `grammar.js`, then:

```sh
tree-sitter generate     # rewrites src/parser.c
tree-sitter test         # the corpus must stay green
```

Commit the regenerated `src/` along with the grammar — consumers build
from the committed C, not from `grammar.js`.

Two things are easy to get wrong:

- **A new keyword needs a corpus test.** A keyword the grammar does not
  know does not produce an error: it matches the identifier rule, so the
  construct silently parses as something else. `pub` was missing until
  2026-09-08 and every public declaration parsed as a bare expression
  statement followed by the declaration, with `has_error()` false.
- **A new keyword needs a highlight.** `queries/highlights.scm` here and
  the copy vendored into novo.nvim have to move together, or the
  keyword parses correctly and still renders as a variable.

## Licence

Apache-2.0.
