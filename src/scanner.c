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
    FSTRING_SEGMENT,
    FSTRING_FORMAT,
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

static inline bool is_op_char(int32_t c) {
    return c == '=' || c == '<' || c == '>' || c == '!' || c == '+' ||
           c == '-' || c == '*' || c == '/' || c == '%' || c == '&' ||
           c == '|' || c == '^';
}

/* Is `run` an ASSIGNMENT operator?  `=` and the compound forms, and
 * nothing that merely ends in `=`: `==`, `<=`, `>=` and `!=` compare,
 * and `=>` does not end in `=` at all. */
static bool op_run_is_assign(const char *run, unsigned n) {
    if (n == 0 || run[n - 1] != '=') return false;
    if (n == 2 && (run[0] == '=' || run[0] == '<' ||
                   run[0] == '>' || run[0] == '!')) return false;
    return true;
}

/* Does the rest of this SOURCE LINE carry an assignment outside every
 * bracket, quote and comment?
 *
 * This is the question that separates the two constructs a
 * statement-initial `*` can begin.  `* b + c` continues the expression
 * on the line above; `*p = v` stores through a raw pointer, and no
 * continuation line can carry a top-level assignment — the operator
 * would have nothing to assign to.  The scanner reads the line rather
 * than asking the parser what it expects, because the parser's
 * expectations do not separate these: `valid_symbols[INDENT]` is true
 * mid-expression as well (measured, seven files), and
 * `valid_symbols[NEWLINE]` is true after `if c` because the grammar
 * makes every body optional so that a truncated file still parses.
 *
 * Reads ahead and answers; the caller returns false either way when it
 * decides the line is a continuation, and tree-sitter re-lexes from the
 * token start, so nothing here is consumed on the parser's behalf. */
static bool line_carries_assignment(TSLexer *lexer) {
    int depth = 0;
    char run[8];
    for (;;) {
        int32_t c = lexer->lookahead;
        if (lexer->eof(lexer) || c == '\n' || c == '\r') return false;
        if (c == '"' || c == '\'') {
            int32_t quote = c;
            advance(lexer);
            while (!lexer->eof(lexer) && lexer->lookahead != quote &&
                   lexer->lookahead != '\n' && lexer->lookahead != '\r') {
                if (lexer->lookahead == '\\') advance(lexer);
                if (lexer->eof(lexer)) return false;
                advance(lexer);
            }
            if (lexer->lookahead == quote) advance(lexer);
            continue;
        }
        if (c == '/') {
            advance(lexer);
            /* `//` opens a comment: the rest of the line is prose. */
            if (lexer->lookahead == '/') return false;
            continue;
        }
        if (c == '(' || c == '[' || c == '{') { depth++; advance(lexer); continue; }
        if (c == ')' || c == ']' || c == '}') { depth--; advance(lexer); continue; }
        if (is_op_char(c)) {
            unsigned n = 0;
            while (is_op_char(lexer->lookahead) && n < sizeof(run)) {
                run[n++] = (char)lexer->lookahead;
                advance(lexer);
            }
            if (depth <= 0 && op_run_is_assign(run, n)) return true;
            continue;
        }
        advance(lexer);
    }
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

    /* ── F-STRING CONTENT IS A SCANNED REGION ───────────────────────
     * The text between the quotes of an f-string is scanned here
     * rather than lexed as a token, and the difference is what `extras`
     * can reach.  `extras` are matched between any two tokens, so with
     * the segment lexed internally a comment spelling in that set was
     * matched INSIDE a string: `"#${e.seq} say"` became a `#` comment
     * that swallowed the rest of the line, closing quote and all, and
     * `"${n:#x}"` broke the same way — `#` is a format-spec flag as
     * well as a comment opener, and both are legitimately string
     * content.  `token.immediate` on the segment was not enough: the
     * extras set is still consulted at the position right after the
     * opening quote.
     *
     * A scanned region has no such position.  The scanner is asked
     * first at every byte where an external token is valid, and
     * FSTRING_SEGMENT is valid exactly where string content may begin —
     * after the opening quote, and after a `}` closes an interpolation.
     * So the content is consumed whole, `extras` never runs inside it,
     * and `#` is free to be a comment everywhere else.
     *
     * The two positions the grammar owns are left to it: `${` opens an
     * interpolation and `"` closes the string, and the segment ends
     * before each.
     *
     * The guard is tree-sitter's error recovery, which calls the
     * scanner with EVERY symbol marked valid.  In that mode this branch
     * would claim any byte anywhere, so it stands down and lets the
     * indent tokens do what they do. */
    if (valid_symbols[FSTRING_SEGMENT] &&
        !(valid_symbols[NEWLINE] && valid_symbols[INDENT] &&
          valid_symbols[DEDENT])) {
        bool any = false;
        for (;;) {
            int32_t c = lexer->lookahead;
            if (lexer->eof(lexer) || c == '"') break;
            if (c == '\\') {
                advance(lexer);
                if (lexer->eof(lexer)) break;
                advance(lexer);
                any = true;
                lexer->mark_end(lexer);
                continue;
            }
            if (c == '$') {
                advance(lexer);
                /* `${` belongs to the grammar.  mark_end still points
                 * before the `$`, so the segment ends there. */
                if (lexer->lookahead == '{') break;
                any = true;
                lexer->mark_end(lexer);
                continue;
            }
            advance(lexer);
            any = true;
            lexer->mark_end(lexer);
        }
        if (any) {
            lexer->result_symbol = FSTRING_SEGMENT;
            return true;
        }
        return false;
    }

    /* The format spec after `${expr:` is a region for the same reason
     * and by the same mechanism.  It was the second half of the same
     * defect: `#` is a spec flag (`"${n:#x}"` is hexadecimal with the
     * `0x` prefix), and a spec lexed as a token leaves the position
     * right after the `:` open to `extras` — the `}` that may follow an
     * empty spec is not an immediate token, so the extras set is
     * consulted there whatever the spec token says about itself.
     *
     * The spec is opaque to the grammar: everything up to the closing
     * `}`.  An empty one is legal (`"${y:}"` is a hole with an empty
     * spec, the split at the `:` being positional), which is the case
     * that returns false and lets the `}` through. */
    if (valid_symbols[FSTRING_FORMAT] &&
        !(valid_symbols[NEWLINE] && valid_symbols[INDENT] &&
          valid_symbols[DEDENT])) {
        bool any = false;
        while (!lexer->eof(lexer)) {
            int32_t c = lexer->lookahead;
            if (c == '}' || c == '"' || c == '\\') break;
            advance(lexer);
            any = true;
            lexer->mark_end(lexer);
        }
        if (any) {
            lexer->result_symbol = FSTRING_FORMAT;
            return true;
        }
        return false;
    }

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

    /* ── A CLOSING BRACKET ENDS THE BLOCK OPENED INSIDE IT ──────────
     * `f(x =>` … `body)` and `f(match k` … `_ => 20)` write the
     * bracket on the body's own last line.  Every other token that
     * closes a block arrives after a newline, which is the only thing
     * step 1 below reacts to, so the block stayed open and the bracket
     * landed in a state that wanted a `_dedent`: the tree came back
     * with `(MISSING _dedent)` and, for the lambda, a `(MISSING ")")`
     * and an ERROR region around the whole call.
     *
     * A zero-width DEDENT here closes it exactly as a dedented line
     * would.  `mark_end` above pins the token to this byte, so nothing
     * is consumed and the bracket lexes normally afterwards.
     *
     * Self-limiting, and that is what stands in for the bracket-depth
     * bookkeeping the canonical lexer keeps: one DEDENT per call, and
     * the parser stops asking for another the moment the bracket
     * itself becomes acceptable — so `f(g(match k` … `))` pops the two
     * blocks it opened and neither of the brackets that opened none.
     *
     * The error-recovery guard is the FSTRING branches' guard above:
     * tree-sitter re-runs the scanner with EVERY symbol marked valid,
     * and in that mode this branch would pop the stack at any bracket
     * anywhere. */
    if ((lexer->lookahead == ')' || lexer->lookahead == ']' ||
         lexer->lookahead == '}') &&
        valid_symbols[DEDENT] && s->indents.size > 1 &&
        !(valid_symbols[NEWLINE] && valid_symbols[INDENT] &&
          valid_symbols[DEDENT])) {
        array_pop(&s->indents);
        lexer->result_symbol = DEDENT;
        return true;
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
     * unparseable (no rule starts with a binary operator).
     *
     * ONE OF THOSE LEADERS IS TWO CONSTRUCTS.  `*` begins a
     * continuation (`* b + c`) and it begins a raw-pointer store
     * (`*p = 1`), and the lookahead cannot tell them apart, so the
     * store lost: it produced ERROR nodes in every position, and the
     * enclosing `if` misparsed with it — `c`, `*p` and the next `*p`
     * collapsed into one binary chain and the `if` ended up with a
     * multi-line condition and no body.
     *
     * The line decides.  A continuation line cannot carry an
     * assignment outside its brackets — a leading binary operator has
     * nothing to assign to — so `line_carries_assignment` separates
     * them, and it reads source rather than guessing from the parser's
     * state.  Neither `valid_symbols[INDENT]` nor
     * `valid_symbols[NEWLINE]` can do this: the first is true
     * mid-expression as well, and the second is true after `if c`
     * because the grammar makes every body optional so a truncated
     * file still parses. */
    if (indent > top) {
        int32_t c = lexer->lookahead;
        if (c == '+' || c == '-' || c == '*' || c == '/' || c == '%' ||
            c == '|' || c == '&' || c == '^' || c == '<' || c == '>' ||
            c == '=' || c == '!' || c == '?' || c == '.') {
            /* Don't consume — return false so the lexer treats the
             * whitespace+newline as extras and the binary operator
             * tokenises normally on the same logical line. */
            if (c != '*' || !line_carries_assignment(lexer)) return false;
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
