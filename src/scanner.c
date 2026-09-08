/* tree-sitter-novo external scanner.
 *
 * Emits three virtual tokens that the grammar uses to fence
 * indent-sensitive blocks (fn bodies, struct fields, match arms,
 * if/for/while/match bodies):
 *
 *   _newline   — after a non-blank source line, when the next
 *                non-blank line is at the same indent depth as
 *                the current top-of-stack
 *   _indent    — when the next non-blank line is at a deeper
 *                column than the current top of stack
 *   _dedent    — when the next non-blank line is at a shallower
 *                column than the top of stack (one _dedent per
 *                stack-pop; multiple may fire in sequence)
 *
 * The scanner runs only when the grammar's LR(1) state actually
 * accepts one of these external tokens; otherwise it returns
 * false and the lexer's normal token rules apply.  This lets
 * inline comments, blank lines, and code structure that doesn't
 * care about indent (parens, brackets, braces) pass through
 * untouched.
 *
 * Indent depth is the number of columns from the start of the
 * line to the first non-whitespace character.  Tabs count as
 * 1 column (matching Novo's convention; mixed indentation is
 * rejected at the parser level by the canonical compiler, but
 * we accept any consistent style here).
 *
 * State is a small int stack of indent depths.  Serialised /
 * deserialised across incremental edits via a fixed-size byte
 * buffer.
 */

#include "tree_sitter/parser.h"
#include "tree_sitter/array.h"

#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <wctype.h>

#ifndef NOVO_TS_TRACE
#define NOVO_TS_TRACE 0
#endif

enum TokenType {
    NEWLINE,
    INDENT,
    DEDENT,
};

typedef struct {
    Array(uint16_t) indents;
} Scanner;

void *tree_sitter_novo_external_scanner_create(void) {
    Scanner *s = ts_calloc(1, sizeof(Scanner));
    array_init(&s->indents);
    /* Stack starts with depth 0 — the document's top level. */
    array_push(&s->indents, 0);
    return s;
}

void tree_sitter_novo_external_scanner_destroy(void *payload) {
    Scanner *s = payload;
    array_delete(&s->indents);
    ts_free(s);
}

unsigned tree_sitter_novo_external_scanner_serialize(
    void *payload, char *buffer
) {
    Scanner *s = payload;
    /* Serialise as: 2-byte count, then 2-byte LE for each indent. */
    unsigned size = 0;
    if (s->indents.size > (TREE_SITTER_SERIALIZATION_BUFFER_SIZE / 2) - 1) {
        return 0;
    }
    buffer[size++] = (char)(s->indents.size & 0xff);
    buffer[size++] = (char)((s->indents.size >> 8) & 0xff);
    for (uint32_t i = 0; i < s->indents.size; i++) {
        uint16_t v = *array_get(&s->indents, i);
        buffer[size++] = (char)(v & 0xff);
        buffer[size++] = (char)((v >> 8) & 0xff);
    }
    return size;
}

void tree_sitter_novo_external_scanner_deserialize(
    void *payload, const char *buffer, unsigned length
) {
    Scanner *s = payload;
    array_clear(&s->indents);
    if (length < 2) {
        array_push(&s->indents, 0);
        return;
    }
    uint16_t n = (uint8_t)buffer[0] | ((uint8_t)buffer[1] << 8);
    unsigned pos = 2;
    for (uint16_t i = 0; i < n && pos + 1 < length; i++) {
        uint16_t v = (uint8_t)buffer[pos] | ((uint8_t)buffer[pos + 1] << 8);
        array_push(&s->indents, v);
        pos += 2;
    }
    if (s->indents.size == 0) {
        array_push(&s->indents, 0);
    }
}

static inline void advance(TSLexer *lexer) {
    lexer->advance(lexer, false);
}

static inline void skip(TSLexer *lexer) {
    lexer->advance(lexer, true);
}

bool tree_sitter_novo_external_scanner_scan(
    void *payload, TSLexer *lexer, const bool *valid_symbols
) {
    Scanner *s = payload;

    /* Mark the byte where any token we emit will END.  Without this
     * call, tree-sitter sets the token's end to wherever the
     * lexer's lookahead has advanced when we return — which after
     * skip()-ing through blank lines lands at the start of the
     * next content line, making fn_decl / block ranges visually
     * extend through trailing whitespace.  mark_end pins the
     * token's end position to the byte BEFORE we start advancing,
     * so DEDENT (and friends) sit cleanly at the boundary between
     * the last body statement and the next top-level construct. */
    lexer->mark_end(lexer);

#if NOVO_TS_TRACE
    fprintf(stderr, "scan: valid=[%s%s%s] lookahead=%c (col=%u)\n",
            valid_symbols[NEWLINE] ? "NL " : "",
            valid_symbols[INDENT]  ? "IN " : "",
            valid_symbols[DEDENT]  ? "DE " : "",
            lexer->lookahead < 32 ? '?' : (char)lexer->lookahead,
            (unsigned)lexer->get_column(lexer));
#endif

    /* If the grammar is at EOF and we still have un-popped indents,
     * emit DEDENT tokens to close the open blocks cleanly. */
    if (lexer->eof(lexer)) {
        if (valid_symbols[DEDENT] && s->indents.size > 1) {
            array_pop(&s->indents);
            lexer->result_symbol = DEDENT;
            return true;
        }
        return false;
    }

    /* Only act on a newline boundary — the grammar is expected to
     * call us right after a non-newline-eating regular token.
     * Step 1: walk past any leading mid-line whitespace and the
     * (one or more) newlines that follow.  We do NOT eat the
     * leading whitespace of the next non-blank line; that's the
     * indent we need to measure. */
    bool seen_newline = false;
    while (lexer->lookahead == ' ' || lexer->lookahead == '\t' ||
           lexer->lookahead == '\n' || lexer->lookahead == '\r') {
        if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
            seen_newline = true;
            skip(lexer);
            /* Stop after the newline; the next iteration's leading
             * whitespace is the indent of the next line. */
            break;
        }
        if (seen_newline) {
            /* Already past the newline; this is leading whitespace
             * of the next line.  Don't consume — let step 2 measure. */
            break;
        }
        skip(lexer);
    }

    if (!seen_newline) {
        return false;
    }

    /* Step 2: measure the indent of the NEXT non-blank, non-comment
     * line.  Blank lines and pure-comment lines are transparent so
     * indentation comparisons skip them. */
    uint16_t indent = 0;
    for (;;) {
        indent = 0;
        while (lexer->lookahead == ' ' || lexer->lookahead == '\t') {
            indent++;
            skip(lexer);
        }
        if (lexer->lookahead == '\n' || lexer->lookahead == '\r') {
            /* Blank line — skip and re-measure. */
            skip(lexer);
            continue;
        }
        if (lexer->eof(lexer)) {
            /* File ends after blank lines — emit DEDENTs to close
             * any open blocks. */
            if (valid_symbols[DEDENT] && s->indents.size > 1) {
                array_pop(&s->indents);
                lexer->result_symbol = DEDENT;
                return true;
            }
            return false;
        }
        break;
    }

    uint16_t top = *array_get(&s->indents, s->indents.size - 1);

    /* Multi-line expression continuation — when the next line is
     * INDENTED PAST the current block depth AND starts with a
     * binary operator (`+`, `-`, `*`, `/`, `|>`, `??`, `==`, etc.)
     * or a `.` — the builder-chain shape, where each `.method(…)`
     * sits on its own line beneath the receiver —
     * don't emit any token.  The lexer's `extras` whitespace rule
     * absorbs the newline, and the parser keeps building the
     * surrounding binary_expr without seeing a statement boundary.
     *
     *     var hdr = "range(" + a
     *             + b + ")"        ← `+` at deeper indent: continuation
     *             + " window=…"
     *
     * Without this rule the lines starting with `+` would be
     * unparseable (no rule starts with a binary operator). */
    if (indent > top) {
        int32_t c = lexer->lookahead;
        if (c == '+' || c == '-' || c == '*' || c == '/' || c == '%' ||
            c == '|' || c == '&' || c == '^' || c == '<' || c == '>' ||
            c == '=' || c == '!' || c == '?' || c == '.') {
            /* Don't consume — return false so the lexer treats the
             * whitespace+newline as extras and the binary operator
             * tokenises normally on the same logical line. */
            return false;
        }
    }

    if (valid_symbols[INDENT] && indent > top) {
        array_push(&s->indents, indent);
        lexer->result_symbol = INDENT;
        return true;
    }
    if (valid_symbols[DEDENT] && indent < top) {
        array_pop(&s->indents);
        lexer->result_symbol = DEDENT;
        return true;
    }
    if (valid_symbols[NEWLINE]) {
        lexer->result_symbol = NEWLINE;
        return true;
    }
    return false;
}
