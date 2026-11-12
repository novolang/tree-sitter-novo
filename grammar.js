/**
 * @file Tree-sitter grammar for Novo — slice 2 bootstrap.
 *
 * Scope (slice 2):
 *   - Comments (// line)
 *   - Literals: Int, Float, Str (incl. f-strings as a single token),
 *     Bool, the unit-ish atoms `true`/`false`/`None`
 *   - Identifiers + qualified paths (`std.fs`, `time.now`)
 *   - Top-level declarations: `use`, `fn` headers, `struct`, `enum`,
 *     `let`/`let mut`
 *   - Function-body lines as a flat statement sequence — no nested
 *     block grammar; indentation is `extras` (ignored).  This means
 *     the CST flattens fn bodies to a list of stmts, but every
 *     token in `examples/lang/*.nv` is still recognised, and the
 *     highlighter can colour at line granularity.
 *
 * Out of scope until slice 5 (grammar parity sweep):
 *   - Indent-sensitive block parsing — needs an external scanner
 *     emitting INDENT/DEDENT tokens (see Implementation notes in
 *     features/orbits/novo-treesitter/README.md).
 *   - The three documented conflict sites (fn-type-vs-lambda,
 *     effect-set-vs-call-args, match-arm indentation).
 *   - Operator precedence climbing for full expressions.
 *   - Type-annotation grammar beyond bare identifiers and `?T`.
 */

module.exports = grammar({
  name: 'novo',

  // External tokens emitted by the C scanner at grammar/src/scanner.c.
  // INDENT / DEDENT bracket indent-sensitive blocks (fn bodies,
  // struct/enum bodies, control-flow bodies); NEWLINE is the
  // statement terminator at block scope.  Tree-sitter calls the
  // external scanner only when the LR state needs one of these
  // tokens, so non-block constructs stay unaffected.
  externals: $ => [
    $._newline,
    $._indent,
    $._dedent,
    // The text between the quotes of an f-string, scanned rather than
    // lexed.  `extras` are matched between any two tokens, so a lexed
    // segment leaves a position inside every string where a comment
    // spelling can win; a scanned region has none.  See the branch in
    // src/scanner.c.
    $.fstring_segment,
    // And the format spec after `${expr:`, for the same reason: the
    // `}` that may follow an empty spec is not an immediate token, so
    // `extras` is consulted at the position right after the `:`.
    $.fstring_format_spec,
  ],

  // Whitespace + newlines + comments — all "ignored" at this
  // slice's granularity.  Slice 5 promotes newlines + indentation
  // back to structural tokens via an external scanner; for slice 5b
  // we trade structural newline-tracking for the ability to span
  // multi-line constructs (attributes followed by fn decls,
  // multi-line let initialisers, etc.).
  // Whitespace (including newlines) is in extras for the regular
  // lexer.  The external scanner runs FIRST at each position, so
  // when the parser is at a state where INDENT/DEDENT/NEWLINE is
  // expected (block boundary), the scanner emits one of those;
  // otherwise extras silently consume the newline like before.
  // This mirrors how the upstream tree-sitter-python grammar
  // handles its indent-sensitive blocks.
  extras: $ => [
    /[ \t\r\n]+/,
    $.line_comment,
    $.hash_comment,
    $.doc_comment,
    $.block_comment,
    $.shebang,
  ],

  word: $ => $.identifier,

  // GLR conflicts that need both paths kept around so that runtime
  // tokens (specifically `=>`) can disambiguate.  paren_expr vs
  // closure_params is the canonical case: `(x)` is paren_expr
  // unless followed by `=>` (then closure_params).
  conflicts: $ => [
    [$._expr, $.closure_params],
    [$.match_stmt, $.match_expr],
    [$._top_level, $._expr],
    [$.type_param, $.named_type],
    // `[a, b]` vs `[a, ...rest]` — the two diverge only at the
    // element after a comma, which can be arbitrarily far in.  Keep
    // both alive and let the `...` decide.
    [$.list_pattern, $.cons_pattern],
    // `match arm guard` — `n if cond => body`.  After parsing
    // `cond` as identifier inside the guard, the parser sees `=>`
    // and could either close the guard (start match_arm body) or
    // extend the guard's identifier into a closure_expr.  Keep
    // both alive; dynamic_prec on closure_expr resolves at runtime
    // against match_arm.
    [$._expr, $.closure_expr],
    // `let (a, b) = e` against `let (P, Q) = e else B`: a tuple of
    // names is a binder or a pattern, and only the `else` after the
    // value decides which.
    [$.tuple_binder, $._pattern],
    // `m.S { ... }` against `m.f(...)` and `m.field`: the module
    // name is an identifier expression until the `{` after the
    // second name settles it as a struct literal.
    [$._expr, $.struct_literal],
  ],

  rules: {
    source_file: $ => repeat(seq($._top_level, optional($._newline))),

    _top_level: $ => choice(
      $.use_decl,
      $.alias_decl,
      $.fn_decl,
      $.struct_decl,
      $.enum_decl,
      $.trait_decl,
      $.impl_decl,
      $.state_machine_decl,
      $.register_decl,
      // The embedded surface.  These five arrived with the hardware
      // work and never reached this grammar, so `bsp Nrf52840` parsed
      // as two identifiers and a board file was one long ERROR region.
      // bugs/tooling/closed/treesitter-grammar-behind-lexer.md
      $.peripheral_decl,
      $.memory_map_decl,
      $.vector_table_decl,
      $.bsp_decl,
      $.static_decl,
      $.error_kind_decl,
      $.req_decl,
      $.const_decl,
      $.frame_decl,
      $.prompt_decl,
      $.unsafe_discharge_stmt,
      // Bare `x: Type` and `Variant(...)` lines that appear inside
      // struct / enum bodies — kept as a top-level alternative for
      // robustness even though slice 5c+ nests them under their
      // parent decl via the external scanner.
      $.struct_field,
      $.let_stmt,
      $.return_stmt,
      $.break_stmt,
      $.continue_stmt,
      $.pass_stmt,
      $.if_stmt,
      $.elif_stmt,
      $.else_stmt,
      $.for_stmt,
      $.while_stmt,
      $.loop_stmt,
      $.match_stmt,
      // `system` and `asm` are statements, not declarations, but
      // `_top_level` is what a `block` repeats, so this is where a
      // fn-body construct is listed.
      $.system_stmt,
      $.wrapping_stmt,
      $.asm_stmt,
      $.expr_stmt,
    ),

    // ── Comments ───────────────────────────────────────────────
    // Three spellings here: `//` line, `///` doc, `/* */` block.
    // `///` and `//` share a prefix, so doc_comment carries the
    // higher precedence to win the disambiguation.
    //
    line_comment: $ => token(prec(1, seq('//', /[^\n]*/))),

    // `#` to end of line, which the reference lexer discards the same
    // way it discards `//`.  It is safe in the extras set because an
    // f-string's content is a scanned region and `extras` cannot enter
    // one: `"#${e.seq} say"` is text and `"${n:#x}"` is a format spec,
    // both of which a lexed segment lost to this rule.  `shebang`
    // carries a higher precedence, so `#!/usr/bin/env novo` on line one
    // is still a shebang.
    hash_comment: $ => token(seq('#', /[^\n]*/)),
    doc_comment: $ => token(prec(2, seq('///', /[^\n]*/))),

    // `/* ... */` block comment.  Used at the head of many real
    // Novo files for licence headers and module-level docs.
    // Cannot nest: `/*  /* nested */  */` would close at the
    // first `*/`, matching most other C-style languages.
    block_comment: $ => token(seq(
      '/*',
      /[^*]*\*+([^/*][^*]*\*+)*/,
      '/',
    )),

    // Shebang on the first line of a script: `#!/usr/bin/env novo`.
    // Matched as an extras token so it doesn't show up structurally
    // but still highlights as a comment.
    shebang: $ => token(prec(3, /#![^\n]*/)),

    // ── use / module path ──────────────────────────────────────
    // `alias Id = Int` — a type alias (SPEC §3.10).  `alias` is the one
    // spelling; `type` at declaration position is a parse error in the
    // reference (it stays reserved for the associated-type member
    // inside a trait or an impl body), so this rule does not accept
    // it — a grammar that parsed the refused form would highlight a
    // file the compiler turns down.  `alias` is a reserved word, so
    // without this rule the line parses as an identifier followed by
    // an assignment: a plausible tree that is quietly wrong whenever
    // the right-hand side is a type but not an expression.
    //
    // `type_params` is the very field a struct header carries, under
    // the same name, so `alias Pair<T> = (T, T)` needs no second
    // spelling of what a type parameter is and the locals query that
    // scopes a struct's parameters covers this too.
    alias_decl: $ => seq(
      attrsAndPub($),
      'alias',
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      '=',
      field('value', $._type_expr),
    ),

    // `use a.b`, `use a.b as c`, `use a.{b, c}`, `use a.{b as d}`,
    // `use a.*`.
    // The brace and glob forms are the package-loader spellings
    // (SPEC §9.3); the plain dotted form works everywhere.
    // A `use` may carry attributes: `@when(noble_controller.CONFIG.CTL_CS > 0)`
    // in front of it loads the module only under that configuration
    // (orbit/noble-controller/src/ctl_hci.nv), and the grammar read the
    // annotated line as an error.
    //
    // `pub use deframe.{ Step, Event }` is how a package root curates
    // its public interface (SPEC § 9.2, § 9.3): the re-export takes
    // `pub` and, with it, annotations on either side like the other
    // declarations.
    use_decl: $ => prec.right(seq(
      attrsAndPub($),
      'use',
      field('path', $.module_path),
      optional(seq('as', field('alias', $.identifier))),
    )),

    module_path: $ => prec.right(seq(
      $.identifier,
      repeat(seq('.', $.identifier)),
      optional(seq('.', choice(
        field('group', $.import_group),
        field('glob', $.import_glob),
      ))),
    )),

    // `{core, cpu, loader}` — the brace-selection tail of a use path.
    // A name may be renamed at the import: `{ Said as HubSaid }`.
    import_group: $ => seq(
      '{',
      sepBy1(',', choice($.identifier, $.import_rename)),
      optional(','),
      '}',
    ),

    // `Said as HubSaid` — the name as the module declares it, and the
    // name this module writes for it (SPEC §9.3).
    import_rename: $ => seq(
      field('name', $.identifier),
      'as',
      field('alias', $.identifier),
    ),

    // `*` — the glob tail of a use path.
    import_glob: $ => '*',

    // ── fn declaration ─────────────────────────────────────────
    // Header only; body is a sequence of stmts at the top level
    // until the next top-level decl (no real block grouping at this
    // slice — see file header).
    // prec.right resolves the `fn name(p) [ …` shift/reduce
    // ambiguity in favour of pulling the `[`-bracketed effect list
    // into fn_decl rather than starting a new expr_stmt.
    //
    // Slice 5c — fn body fenced by the INDENT/DEDENT external
    // tokens.  Without a body, fn_decl is just the header (e.g. an
    // @ffi decl).  This is what unlocks `vaf` (visual select around
    // function) in nvim-treesitter-textobjects.
    fn_decl: $ => prec.right(seq(
      attrsAndPub($),
      // Modifiers: `async fn`, `const fn`, or both.
      optional(choice('async', 'const')),
      'fn',
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      field('params', $.param_list),
      optional(field('return_type', seq('->', choice($.readonly_type, $._ret_type)))),
      optional(field('effects', $.effect_list)),
      optional(field('body', $.block)),
    )),

    // INDENT-bracketed block — used by fn bodies, control-flow
    // bodies once those grow bodies, and any other indent-sensitive
    // construct.  Reuses the top-level alternative set so the body
    // can contain anything a script can.  Each item consumes an
    // optional trailing newline so expressions don't greedily
    // continue onto the next line via call_expr / index_expr
    // (`m()` followed by `[...]` on the next line was parsing as
    // `m()[...]` — a real-world list-literal-as-fn-body case).
    block: $ => seq(
      $._indent,
      repeat(seq($._top_level, optional($._newline))),
      $._dedent,
    ),

    attribute: $ => seq(
      '@',
      $.identifier,
      // Two-part dotted names — `@intent.verify(runtime)`.
      optional(seq('.', $.identifier)),
      optional(seq(
        '(',
        // Bag of tokens until the matching `)`.  `req_id` covers
        // `@satisfies(REQ-DNS-001)`-style annotations whose
        // argument is the dashed requirement id (which can't
        // parse as a regular identifier).
        repeat($._attribute_arg),
        ')',
      )),
    ),

    // One token of an attribute's argument list, or a parenthesised
    // group of them.  `@when(cfg.CTL_LINKS >= 2 and cfg.CTL_CIS == 1)`
    // is a condition, so the dot of a qualified name, the comparison
    // and arithmetic operators and the words `and`, `or`, `not` take
    // part; the compiler reads the condition, this grammar only has to
    // reach the closing parenthesis.
    _attribute_arg: $ => choice(
      $.identifier,
      $.req_id,
      $.string_literal,
      $.integer_literal,
      $.float_literal,
      ',', '=', '.',
      '==', '!=', '<', '>', '<=', '>=',
      '+', '-', '*', '/', '%',
      'and', 'or', 'not',
      seq('(', repeat($._attribute_arg), ')'),
    ),

    // `<T>`, `<T, U>`, `<S: Greet>`, `<S: Greet + Describe>`,
    // `<A: Greet, B: Describe>` — each type parameter may carry
    // a `: Trait` constraint, with `+ Trait` chains for multi-
    // bound parameters.
    //
    // Some Novo code (orbit/ble) uses `[T: Trait]` square-bracket
    // syntax instead of angle brackets.  Accept both shapes.
    type_params: $ => choice(
      seq('<', sepBy1(',', $.type_param), '>'),
      // `[T: Trait]` — square-bracket variant.  prec.dynamic
      // above the list_type / list_literal interpretation so
      // `impl [T: Foo] X` and `fn name[T](...)` resolve to type
      // params rather than `[T] = list-of-T`.
      prec.dynamic(2, seq('[', sepBy1(',', $.type_param), ']')),
    ),

    // A bound may carry an EFFECT ARGUMENT — `<S: Source[e]>` binds the
    // trait's effect parameter for the enclosing function, which may
    // then write `[e]` in its own effect row (SPEC §5.6).  The argument
    // reuses `effect_list`, so the bracketed name is the same node the
    // row itself is made of and no new node type enters the ABI.
    type_param: $ => prec.right(seq(
      $.identifier,
      optional(seq(':', sepBy1('+',
        seq($.identifier, repeat(seq('.', $.identifier)),
            optional(field('effects', $.effect_list)))))),
    )),

    param_list: $ => seq(
      '(',
      optional(sepBy1(',', choice($.self_param, $.param))),
      optional(','),
      ')',
    ),

    // `self`, `mut self`, or `var self` as the first param of an
    // impl method.  Bare — no type annotation.
    self_param: $ => seq(
      optional(choice('mut', 'var')),
      'self',
    ),

    param: $ => seq(
      optional(choice('mut', 'var')),
      field('name', choice($.identifier, alias($._frame_name, $.identifier))),
      ':',
      field('type', $._type_expr),
      optional(seq('=', field('default', $._expr))),
    ),

    effect_list: $ => seq(
      '[',
      sepBy(',', $.identifier),
      ']',
    ),

    // ── struct / enum ──────────────────────────────────────────
    // Slice 5c — header + indent-fenced body.  The body is a
    // sequence of struct fields (`x: Float`) for structs and
    // expr_stmt-shaped variant calls (`Circle(radius: Float)`) for
    // enums, plus blank lines or comments via the existing extras
    // path.  `block` is reused — it just allows `_top_level`
    // entries which already covers both cases at this slice.
    struct_decl: $ => prec.right(seq(
      attrsAndPub($),
      'struct',
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      optional(field('body', $.block)),
    )),

    // enum body is a list of variant declarations (`Circle`,
    // `Circle(radius: Float)`, `ExSubquery(e: Expr, neg: Bool)`).
    // Reuses event_variant_block since the shape is identical to
    // a state-machine `events` block.  Without this, `?T` and
    // `[T]` typed fields fall into ERROR because a generic `block`
    // would parse them as `expr_stmt(call_expr(named_arg))` and
    // named_arg's value position rejects `?T`.
    enum_decl: $ => prec.right(seq(
      attrsAndPub($),
      'enum',
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      optional(field('body', $.event_variant_block)),
    )),

    // `error_kind Foo \n  Variant code: "..."` — Novo DSL for
    // typed error sets (used in orbit/dns).  Body is a list of
    // variants; each carries a payload-style metadata dict.
    error_kind_decl: $ => prec.right(seq(
      'error_kind',
      field('name', $.identifier),
      optional(field('body', $.error_variant_block)),
    )),

    // Requirements DSL — `.req.nv` files.  Three categories
    // (functional / nfr / constraint), each declaration:
    //
    //   functional REQ-DNS-001 "Title"
    //     priority: high
    //     description: "..."
    //     acceptance: "..."     (may repeat)
    //     tags: a, b, c
    //
    // The category keywords are top-level keywords here; the
    // REQ-ID has dashes (`REQ-DNS-001`) so it gets its own lexer
    // token rather than reusing identifier.
    req_decl: $ => prec.right(seq(
      field('category', choice('functional', 'nfr', 'constraint')),
      field('id', $.req_id),
      field('title', $.string_literal),
      optional(field('body', $.req_body)),
    )),

    req_id: $ => token(/REQ-[A-Z0-9][A-Z0-9_-]*/),

    req_body: $ => seq(
      $._indent,
      repeat($.req_field),
      $._dedent,
    ),

    // `key: <value>` lines.  Value is a string literal, a single
    // identifier, OR a comma-separated identifier list (for tags).
    req_field: $ => prec.right(seq(
      field('key', $.identifier),
      ':',
      field('value', choice(
        $.string_literal,
        $.req_tag_list,
        $.identifier,
      )),
    )),

    req_tag_list: $ => seq(
      $.req_tag,
      repeat1(seq(',', $.req_tag)),
    ),

    // Tags allow hyphens AND digit-starting forms — `wire-format`,
    // `arch-layering`, `1m`, `2m`, `phy-update`.  The first
    // character can be alpha or digit.  Built from identifier or
    // a tagged-with-digits token, plus repeated `-segment` chains.
    req_tag: $ => seq(
      choice(
        $.identifier,
        alias(token(/[0-9][a-zA-Z0-9_]*/), $.req_tag_digit),
      ),
      repeat(seq(
        token.immediate('-'),
        token.immediate(/[a-zA-Z0-9_][a-zA-Z0-9_]*/),
      )),
    ),

    error_variant_block: $ => seq(
      $._indent,
      repeat(seq($.error_variant, optional($._newline))),
      $._dedent,
    ),

    // `Truncated  code: "DNS-001"` or `Variant(payload: T) code: "..."`.
    // Each variant is one source line — newline terminator stops
    // the trailing metadata from greedily eating the next variant
    // line as another key: value pair.
    error_variant: $ => prec.right(seq(
      field('name', $.identifier),
      optional(seq(
        '(',
        optional(sepBy1(',', $.param)),
        optional(','),
        ')',
      )),
      repeat(seq($.identifier, ':', $._expr)),
    )),

    // `trait Greet \n  fn hello(self) -> Str` — declares a method
    // signature surface.  Body is a list of fn headers (and maybe
    // default-impl fns) at deeper indent.
    // `trait Map<K, V> : Collection` — the tail after `:` names the
    // supertraits a conforming type must also implement.
    trait_decl: $ => prec.right(seq(
      // `pub` marks the declaration part of the package's public
      // surface.  It was missing entirely until 2026-09-08, which
      // did not read as an error: `pub` matched the identifier rule,
      // so every public declaration silently parsed as a bare
      // expression statement followed by the declaration.
      optional(field('visibility', 'pub')),
      'trait',
      field('name', $.identifier),
      optional(field('type_params', $.type_params)),
      // The trait's effect parameter after its type parameters:
      // `trait Rich<T: Ord>[e]: Eq + Ord` (SPEC § 5.6).  Written
      // alone, `trait FrameTransport[e]`, it reads as the bracketed
      // type-parameter list above and gives the same tree as before.
      optional(field('effects', $.effect_list)),
      optional(seq(':', field('supertraits', sepBy1('+', $._type_expr)))),
      optional(field('body', $.block)),
    )),

    // `impl T` (inherent impl) or `impl Trait for T` (trait impl).
    // Body is a list of fn definitions at deeper indent.
    // The subject may carry an effect row (`impl Read[io] for File`)
    // when the trait binds an effect parameter — including the empty
    // row `impl Read[] for Buffer`, which discharges it.  SPEC §5.6.
    impl_decl: $ => prec.right(seq(
      'impl',
      optional(field('type_params', $.type_params)),
      field('subject', $._ret_type),
      optional(field('effects', $.effect_list)),
      optional(seq('for', field('target', $._type_expr))),
      optional(field('body', $.block)),
    )),

    // M29 state machines.  Header is `state_machine Name`, body is
    // a sequence of three sub-blocks (each optional, any order):
    //   states         — newline-separated variant names
    //   events         — newline-separated variants (nullary or
    //                    payload-bearing constructor decls)
    //   transitions    — `pattern => target` arms (often tuple
    //                    patterns like `(Red, Tick) => Green`)
    state_machine_decl: $ => prec.right(seq(
      'state_machine',
      field('name', $.identifier),
      optional(field('body', $.state_machine_block)),
    )),

    // M29 memory-mapped register decl:
    //   register NAME at 0x40001000 : u32
    //       field foo : 1
    //       field bar : 2 @ 8     (with explicit bit offset)
    // and the computed-address array an SVD import writes:
    //   register CNF[32] at 0x700 stride 4 : u32
    register_decl: $ => prec.right(seq(
      'register',
      field('name', $.identifier),
      optional(seq('[', field('count', $.integer_literal), ']')),
      optional(seq('at', field('addr', $._expr))),
      optional(seq('stride', field('stride', $.integer_literal))),
      optional(seq(':', field('type', $._type_expr))),
      optional(field('body', $.field_decl_block)),
    )),

    field_decl_block: $ => seq(
      $._indent,
      repeat($.field_decl),
      $._dedent,
    ),

    field_decl: $ => prec.right(seq(
      'field',
      field('name', $.identifier),
      ':',
      field('width', $.integer_literal),
      optional(seq('@', field('offset', $.integer_literal))),
    )),

    // ── the embedded surface ───────────────────────────────────
    // Five declarations and two statements that the reference lexer
    // reserves and this grammar did not know.  A missing keyword here
    // is not a parse ERROR — the word matches the identifier rule, so
    // `bsp Nrf52840` parsed as two identifiers and `has_error()` was
    // false, which is what made the drift invisible to the corpus
    // tests.  bugs/tooling/closed/treesitter-grammar-behind-lexer.md
    //
    // `peripheral UART0 at 0x40002000` — a register group.  The body
    // is register decls, which already have a rule.
    //
    // `pub peripheral type NrfGpioPort` is the base-less form (SPEC
    // § 17.1): a block's registers at offsets from a base the type does
    // not fix, so there is no `at`.  It takes `pub` and annotations like
    // the other declarations, and keeps this node, so the register
    // lines under it highlight and fold the same way.
    peripheral_decl: $ => prec.right(seq(
      attrsAndPub($),
      'peripheral',
      optional('type'),
      field('name', $.identifier),
      optional(seq('at', field('addr', $._expr))),
      optional(field('body', $.block)),
    )),

    // `memory_map nrf52840` — regions and section placements for the
    // linker.  The member keywords (`region`, `section`, `at`, `size`,
    // `in`, `load_to`, `pad_to`, `entry_point`) are contextual IDENTs
    // in the reference parser, so they are spelled here rather than
    // reserved.
    memory_map_decl: $ => prec.right(seq(
      'memory_map',
      optional(field('name', $.identifier)),
      optional(field('body', $.memory_map_block)),
    )),

    memory_map_block: $ => seq(
      $._indent,
      repeat(choice(
        $.memory_region,
        $.memory_section,
        $.entry_point_line,
      )),
      $._dedent,
    ),

    // `region FLASH at 0x00000000 size 512K` — the size may carry a
    // K / M / G suffix, which lexes as an integer followed by an
    // identifier.
    memory_region: $ => prec.right(seq(
      'region',
      field('name', $.identifier),
      'at', field('base', $._expr),
      'size', field('size', $._expr),
      optional(field('unit', $.identifier)),
    )),

    // `section .text in FLASH`, `... load_to RAM`, `... pad_to 0x100`,
    // and `... words [0xffffded3, 0x10210142]`, which writes these
    // 32-bit words into the section (the RP2350's IMAGE_DEF block, the
    // ESP32-C6's application descriptor; docs/bsp-in-novo.md).  The
    // list may continue over several lines.
    memory_section: $ => prec.right(seq(
      'section',
      field('name', $.section_name),
      'in', field('region', $.identifier),
      optional(choice(
        seq('load_to', field('load_to', $.identifier)),
        seq('pad_to', field('pad_to', $._expr)),
        seq('words', '[', sepBy1(',', field('word', $.integer_literal)),
            optional(','), ']'),
      )),
    )),

    // `.text`, `.ARM.exidx` — a dotted name that does not start with
    // an identifier character, so it needs its own token.
    section_name: $ => token(seq('.', /[A-Za-z_][A-Za-z0-9_]*/,
                                 repeat(seq('.', /[A-Za-z_][A-Za-z0-9_]*/)))),

    entry_point_line: $ => prec.right(seq(
      'entry_point',
      field('symbol', $.identifier),
    )),

    // `vector_table cortex_m at 0x00000000` — ARM-defined slots, then
    // either `irqs from bsp.<chip>` or an inline `irqs a = 1, b = 2`.
    vector_table_decl: $ => prec.right(seq(
      'vector_table',
      field('arch', $.identifier),
      optional(seq('at', field('addr', $._expr))),
      optional(field('body', $.vector_table_block)),
    )),

    vector_table_block: $ => seq(
      $._indent,
      repeat(choice($.vector_slot, $.vector_irqs)),
      $._dedent,
    ),

    // `reset  Reset_Handler` — a slot name and the symbol it maps to.
    vector_slot: $ => prec.right(seq(
      field('slot', $.identifier),
      field('handler', $.identifier),
    )),

    vector_irqs: $ => prec.right(seq(
      'irqs',
      choice(
        seq('from', field('source', $.module_path)),
        sepBy1(',', seq(field('name', $.identifier), '=',
                        field('slot', $.integer_literal))),
      ),
    )),

    // `bsp Nrf52840` — the board, in one declaration: scalars, a
    // nested memory_map, nested peripherals and `irq N vector M`
    // lines.
    // The precedence is what tells `bsp Nrf52840` (a declaration)
    // from `bsp.board.init()` (the stdlib module head, `bsp_ns`
    // below): the two collide on `bsp` followed by an identifier, and
    // a declaration is what that is — the namespace form always has a
    // `.` next.
    bsp_decl: $ => prec.right(1, seq(
      'bsp',
      field('name', $.identifier),
      optional(field('body', $.bsp_block)),
    )),

    bsp_block: $ => seq(
      $._indent,
      repeat(choice(
        $.bsp_scalar,
        $.bsp_irq,
        $.bsp_board,
        $.bsp_devices,
        $.memory_map_decl,
        $.peripheral_decl,
      )),
      $._dedent,
    ),

    // `board` — the pin catalogue, one `<name> <pin>` line each, which
    // a program reads as `bsp.board.<name>()`.  The reference parser
    // reads `board` and `devices` as contextual IDENTs followed by an
    // indented block; the keyword here only applies inside a `bsp`
    // body, so `bsp.board.init()` keeps `board` a field name.
    bsp_board: $ => seq(
      'board',
      $._indent,
      repeat($.bsp_pin),
      $._dedent,
    ),

    bsp_pin: $ => prec.right(seq(
      field('name', $.identifier),
      field('pin', $.integer_literal),
    )),

    // `devices` — the chips on the board's buses, one named device per
    // line:
    //   <name> <DriverType> from "<package>" on <i2cN|spiN|pulseN>
    //          [addr <n>] [cs <pin>] [irq <pin>] [len <n>] [en <pin>]
    // Every word after the package opens with its keyword, so a line
    // ends where the next device's name begins.  The words may come in
    // any order, as the reference parser takes them; which ones a bus
    // requires is the compiler's check, not the editor's.
    bsp_devices: $ => seq(
      'devices',
      $._indent,
      repeat($.bsp_device),
      $._dedent,
    ),

    bsp_device: $ => prec.right(seq(
      field('name', $.identifier),
      field('driver', $.identifier),
      'from',
      field('package', $.string_literal),
      repeat(choice(
        seq('on', field('bus', $.identifier)),
        seq('addr', field('addr', $.integer_literal)),
        seq('cs', field('cs', $._bsp_pin_ref)),
        seq('irq', field('irq', $._bsp_pin_ref)),
        seq('len', field('len', $.integer_literal)),
        seq('en', field('en', $._bsp_pin_ref)),
      )),
    )),

    // A pin: the chip's number, or a name of the `board` block.
    _bsp_pin_ref: $ => choice($.integer_literal, $.identifier),

    // `arch "cortex_m4"`, `cpu_clock_hz 64000000` — the field names
    // are contextual IDENTs in the reference parser.
    bsp_scalar: $ => prec.right(seq(
      field('key', $.identifier),
      field('value', choice($.string_literal, $.integer_literal)),
    )),

    // `irq UARTE0_UART0 vector 2 alias UARTE0, UART0` — the alias
    // names are further names `@isr(...)` accepts for the same line.
    bsp_irq: $ => prec.right(seq(
      'irq',
      field('name', $.identifier),
      'vector',
      field('slot', $.integer_literal),
      optional(seq('alias', sepBy1(',', field('alias', $.identifier)))),
    )),

    // `static BUF : [u8; 4096]`, optionally `at 0x2000_0000` —
    // addressable storage in BSS or at a fixed address.  Only
    // `[u8; N]` is accepted by the reference parser; the grammar
    // takes any array type so a wrong width highlights as Novo and
    // is refused by the compiler rather than by the editor.
    static_decl: $ => prec.right(seq(
      attrsAndPub($),
      'static',
      field('name', $.identifier),
      ':',
      field('type', $._type_expr),
      optional(seq('at', field('addr', $._expr))),
    )),

    // `system` — the explicit-allocation block at @tier(embedded).
    system_stmt: $ => prec.right(seq(
      'system',
      optional(field('body', $.block)),
    )),

    // `wrapping` — a block whose `Int` arithmetic wraps instead of
    // trapping (SPEC § 13.2).  The reference lexer makes the word a
    // keyword only alone on its line, and a name everywhere else.  Here
    // the keyword token is also an expression (`wrapping_name` below),
    // so what follows the word decides: an indented block on the next
    // line makes this statement, and anything on the same line, such as
    // the `(` of a call, makes the word a name.
    wrapping_stmt: $ => prec.right(seq(
      'wrapping',
      field('body', $.block),
    )),

    // Inline asm, both spellings the reference parser takes:
    //   asm cortex_m { "nop" } clobbers "memory", "cc"
    //   asm cortex_m
    //       """bkpt #0xAB"""
    //       input  op = X @ "{r0}"
    // The operand keywords are contextual IDENTs, so the block form is
    // a run of lines rather than a spelled-out member list.
    asm_stmt: $ => prec.right(seq(
      'asm',
      field('arch', $.identifier),
      choice(
        seq('{', field('template', $.string_literal), '}',
            optional(seq('clobbers',
                         sepBy1(',', $.string_literal)))),
        optional(field('body', $.asm_block)),
      ),
    )),

    // The block form of `asm`: the template on its own line, then the
    // operands, one to a line (parser.mly asm_stmt, asm_item).
    // `input`, `output` and `clobber` are contextual words in the
    // reference parser; they are keywords here only in this body.
    asm_block: $ => seq(
      $._indent,
      field('template', $.string_literal),
      repeat(choice($.asm_input, $.asm_output, $.asm_clobber)),
      $._dedent,
    ),

    // `input op = 0x18 @ "{r0}"` — a value placed in a register by the
    // constraint after the `@`.
    asm_input: $ => seq(
      'input',
      field('name', $.identifier),
      '=',
      field('value', $._expr),
      '@',
      field('constraint', $.string_literal),
    ),

    // `output ch : Int @ "={r0}"` — a value read back from a register.
    asm_output: $ => seq(
      'output',
      field('name', $.identifier),
      ':',
      field('type', $._type_expr),
      '@',
      field('constraint', $.string_literal),
    ),

    // `clobber "memory"` — a register or resource the template changes.
    asm_clobber: $ => seq(
      'clobber',
      field('value', $.string_literal),
    ),

    state_machine_block: $ => seq(
      $._indent,
      repeat(choice(
        $.states_block,
        $.events_block,
        $.transitions_block,
      )),
      $._dedent,
    ),

    // `states\n    Red\n    Yellow\n    Green` — variant list.
    // Accepts payload variants too (`Opening(p: Float)`) since the
    // M29 surface allows both forms in `states` blocks.
    states_block: $ => prec.right(seq(
      'states',
      optional(field('body', $.event_variant_block)),
    )),

    // `events\n    Tick\n    Opening(p: Float)` — variants with
    // optional payload constructor.
    events_block: $ => prec.right(seq(
      'events',
      optional(field('body', $.event_variant_block)),
    )),

    // `transitions\n    (Red, Tick) => Green` — match-arm-shaped
    // entries.  Reuses match_block since the body is identical.
    transitions_block: $ => prec.right(seq(
      'transitions',
      optional(field('body', $.match_block)),
    )),

    // Block of bare identifiers, one per line — for `states`.
    identifier_block: $ => seq(
      $._indent,
      repeat($.identifier),
      $._dedent,
    ),

    // Block of event variants.  Each is either a bare identifier
    // (nullary variant) or a constructor-style decl with payload.
    event_variant_block: $ => seq(
      $._indent,
      repeat($.event_variant),
      $._dedent,
    ),

    event_variant: $ => choice(
      $.identifier,
      seq(
        field('name', $.identifier),
        '(',
        optional(sepBy1(',', $.param)),
        optional(','),
        ')',
      ),
    ),

    // `x: Float`, `@be x: u16` — struct field line.  Optional
    // attribute prefix (e.g. `@be` for big-endian field marker).
    // A field may be declared `var` or `mut`, with or without a
    // preceding endian tag (`@be var m: Int`), and may carry the value
    // it takes when nothing supplies one (`retries: Int = 3`).
    struct_field: $ => prec(1, seq(
      optional(field('attrs', repeat1($.attribute))),
      optional(choice('var', 'mut')),
      field('name', choice($.identifier, alias('frame', $.identifier))),
      ':',
      field('type', $._type_expr),
      optional(seq('=', field('default', $._expr))),
    )),

    // ── let statement ──────────────────────────────────────────
    // The binder is a name or a parenthesised positional tuple
    // destructure — `let (client, _) = pair`, or `var (a, b) = f()`
    // with writable names.  The reference grammar's `let_tuple_stmt`
    // (compiler/lib/parser.mly) has no type annotation and no `mut`
    // form, so the destructure is a separate alternative rather than a
    // widened `name` field.
    let_stmt: $ => choice(
      seq(
        choice('let', 'var'),
        optional('mut'),
        // `_` lexes as its own token wherever a pattern may start, and
        // the `else` form below lets one start here.
        field('name', choice($.identifier, alias($._frame_name, $.identifier),
                             $.wildcard_pattern)),
        optional(seq(':', field('type', $._type_expr))),
        '=',
        field('value', $._expr),
      ),
      seq(
        choice('let', 'var'),
        field('name', $.tuple_binder),
        '=',
        field('value', $._expr),
      ),
      // `let P = e else B` — a pattern that can fail, then a block that
      // leaves, written below or as one statement on the
      // same line (`else return None`).  Told apart from the two
      // forms above by the `else`.
      prec.right(seq(
        choice('let', 'var'),
        field('pattern', $._let_else_pattern),
        '=',
        field('value', $._expr),
        'else',
        optional(field('else', choice(
          $.block,
          $.return_stmt,
          $.break_stmt,
          $.continue_stmt,
          $._expr,
        ))),
      )),
    ),

    // The patterns `let … else` takes: every pattern but a bare name,
    // `_` and a literal, which begin a plain `let` or no statement at
    // all.  Admitting them made every `let x = e` and `let _ = e` a
    // candidate for the `else` form, and the parser chose it and then
    // reported the `else` missing.
    _let_else_pattern: $ => choice(
      $.or_pattern,
      $.as_pattern,
      $.tuple_pattern,
      $.struct_pattern,
      $.list_pattern,
      $.cons_pattern,
      $.constructor_pattern,
    ),

    // `(a, _)` in `let` binding position.  `_` is a binder here
    // exactly as it is in `let _ = f()` and `fn on_tick(_: Int)`.
    tuple_binder: $ => seq(
      '(',
      sepBy1(',', choice($.identifier, $.wildcard_pattern)),
      ')',
    ),

    // `const NAME: Type = value` — compile-time constant.  Same
    // shape as let_stmt with `:` type required.
    const_decl: $ => seq(
      // `pub` marks the declaration part of the package's public
      // surface.  It was missing entirely until 2026-09-08, which
      // did not read as an error: `pub` matched the identifier rule,
      // so every public declaration silently parsed as a bare
      // expression statement followed by the declaration.
      optional(field('visibility', 'pub')),
      'const',
      field('name', $.identifier),
      optional(seq(':', field('type', $._type_expr))),
      '=',
      field('value', $._expr),
    ),

    // `frame Name = Hdr ++ Body` — slice-N frame composition DSL.
    // The `++` operator concatenates frame layers.
    // The precedence is what reads `frame Name =` as the declaration
    // and not as the name `frame` followed by another name: nothing
    // else puts two names in a row at a statement's start.
    frame_decl: $ => prec.right(1, seq(
      'frame',
      field('name', $.identifier),
      '=',
      field('value', sepBy1('++', $._type_expr)),
    )),

    // M28 prompt declarations:
    //   prompt Name(params) = "template"        (base form)
    //   prompt Name : Parent                    (inheritance with overrides)
    //   prompt Name : Parent\n  override = "x"  (block of overrides)
    prompt_decl: $ => prec.right(choice(
      seq(
        'prompt',
        field('name', $.identifier),
        field('params', $.param_list),
        '=',
        field('template', $.string_literal),
      ),
      seq(
        'prompt',
        field('name', $.identifier),
        ':',
        field('parent', $.identifier),
        optional(field('overrides', $.block)),
      ),
    )),

    // `unsafe_discharge [effect, …]` — closed-effect-discharge
    // statement (used in novodb to contain `[time]` etc.).  The
    // effect list is the same `[name, name]` shape as fn effects.
    unsafe_discharge_stmt: $ => seq(
      'unsafe_discharge',
      field('effects', $.effect_list),
      optional(field('body', $.block)),
    ),

    // Bag-of-stuff statement — anything that's an expression at
    // statement position.  Slice 2 keeps the expression grammar
    // intentionally narrow.  Also handles bare assignment statements
    // (`x = expr`, `x += expr`) which look like binary expressions
    // but live at statement scope.
    expr_stmt: $ => choice(
      $.assignment_stmt,
      $._expr,
    ),

    // `name = expr` and `name op= expr` (compound assignment).
    // dynamic_prec keeps the parser from trying assignment_stmt
    // when the LHS is anything but a plain identifier or
    // field/index access.
    // `*p = v` stores through a raw pointer, and `deref_target` is
    // its target.  It reaches the parser because the external
    // scanner's continuation rule is gated on the previous line
    // having been one the parser would accept as finished — a
    // statement-initial `*` under a header that still owes a body is
    // a store, not the middle of a wrapped expression.  Reading
    // through a pointer (`1 + *p`) goes through unary_expr and is
    // unaffected.
    assignment_stmt: $ => prec.dynamic(1, seq(
      field('target', choice($.identifier, alias($._wrapping_name, $.identifier),
                             alias($._frame_name, $.identifier), $.self_expr,
                             $.field_access, $.index_expr, $.deref_target)),
      field('op', choice('=', '+=', '-=', '*=', '/=', '%=',
                         '|=', '&=', '^=', '<<=', '>>=', '>>>=')),
      field('value', $._expr),
    )),

    // The target of a raw-pointer store.  Its own rule rather than a
    // reuse of `unary_expr` so a highlight query can colour a store
    // target differently from a read, and so the `*` binds exactly one
    // postfix chain: `*p.next = v` stores through `p.next`.
    // The operand is a PLACE rather than an arbitrary expression:
    // `*p`, `*p.next`, `*xs[i]`, `**pp`.  Taking `$._expr` here makes
    // `'*' identifier '=>' identifier` ambiguous against a closure
    // body that is itself an assignment, and the wider rule buys
    // nothing — nothing else is storable.
    deref_target: $ => prec(11, seq(
      '*',
      choice($.identifier, $.field_access, $.index_expr, $.deref_target),
    )),

    // ── Control-flow statement headers (slice 5b) ────────────────
    // No indent tracking yet — the bodies that follow these
    // headers parse as separate top-level statements at this
    // slice's granularity.  This keeps highlighting honest about
    // what the keywords are without claiming structural nesting
    // we can't yet enforce.

    return_stmt: $ => prec.right(seq(
      'return',
      optional($._expr),
    )),

    // `break` alone, or `break value` out of a loop used as an
    // expression.  Same shape as return_stmt.
    break_stmt: $ => prec.right(seq(
      'break',
      optional($._expr),
    )),
    continue_stmt: $ => 'continue',
    pass_stmt: $ => 'pass',

    // `if cond`, or `if let P = e` / `if var P = e`, which runs the
    // body with the pattern's names bound when the value matches.
    if_stmt: $ => prec.right(seq(
      'if',
      choice(
        field('condition', $._expr),
        seq(
          field('binding', choice('let', 'var')),
          field('pattern', $._pattern),
          '=',
          field('value', $._expr),
        ),
      ),
      optional(field('body', $.block)),
    )),

    elif_stmt: $ => prec.right(seq(
      'elif',
      field('condition', $._expr),
      optional(field('body', $.block)),
    )),

    else_stmt: $ => prec.right(seq(
      'else',
      optional(field('body', $.block)),
    )),

    for_stmt: $ => prec.right(seq(
      'for',
      // Binder is usually a single ident, but tuple destructuring
      // (`for (x, y) in pairs`) is common.  Accept any pattern —
      // plus the annotated form `for x: T in xs`, which is a typed
      // binder rather than a pattern.
      choice(
        seq(field('binder', $.identifier), ':', field('binder_type', $._type_expr)),
        field('binder', $._pattern),
      ),
      'in',
      field('iter', $._expr),
      optional(field('body', $.block)),
    )),

    while_stmt: $ => prec.right(seq(
      'while',
      field('condition', $._expr),
      optional(field('body', $.block)),
    )),

    loop_stmt: $ => prec.right(seq(
      'loop',
      optional(field('body', $.block)),
    )),

    match_stmt: $ => prec.right(seq(
      'match',
      field('scrutinee', $._expr),
      optional(field('body', $.match_block)),
    )),

    // Match-block — INDENT/DEDENT-fenced list of match_arms.
    // Each arm consumes a trailing NEWLINE so the body's expression
    // can't greedily extend onto the next line (otherwise
    // `(A, B) => C\n(D, E) => F` would parse as `C(D, E)` —
    // `C` followed by call_expr args from the next arm).
    // An arm body may be a block `if`, whose `else` sits back at the
    // arm's own indentation — the block closes on the DEDENT before
    // `else`, leaving the `else` line looking for a home.  The
    // grammar models if/elif/else as a flat chain of siblings rather
    // than a nested tree, so admitting the two continuation
    // statements here is what lets that shape land.
    match_block: $ => seq(
      $._indent,
      repeat(seq(
        choice($.match_arm, $.elif_stmt, $.else_stmt, $.if_stmt),
        optional($._newline),
      )),
      $._dedent,
    ),

    // Match arm — `pattern => body` where body can be an expr,
    // an assignment, a `return` (`None => return err(...)`), or a
    // multi-line block.
    match_arm: $ => prec.right(seq(
      field('pattern', $._pattern),
      optional(seq('if', field('guard', $._expr))),
      '=>',
      choice(
        field('body', $.assignment_stmt),
        field('body', $.return_stmt),
        field('body', $.break_stmt),
        field('body', $.continue_stmt),
        field('body', $._expr),
        field('body', $.block),
      ),
    )),

    _pattern: $ => choice(
      $.or_pattern,
      $.as_pattern,
      $.wildcard_pattern,
      $.tuple_pattern,
      $.struct_pattern,
      $.list_pattern,
      $.cons_pattern,
      $.range_pattern,
      $.constructor_pattern,
      $.identifier_pattern,
      $.literal_pattern,
    ),

    // `1..5`, `1..=5`, and the hex spellings.  integer_literal
    // already covers hex, so one rule serves all four of the
    // reference's productions.
    range_pattern: $ => prec(3, seq(
      $._range_bound,
      choice('..', '..='),
      $._range_bound,
    )),

    // A bound is decimal, hex or negative: `0x80..=2047`, `-128..=-1`.
    _range_bound: $ => seq(optional('-'), $.integer_literal),

    // `Point { }`, `Point { .. }`, `Point { x: 0, y }`,
    // `Point { x, y, .. }` — a field named alone binds it by name.
    struct_pattern: $ => prec(3, seq(
      field('type', $.identifier),
      '{',
      optional(choice(
        '..',
        seq(
          sepBy1(',', $.struct_pattern_field),
          optional(seq(',', '..')),
        ),
      )),
      '}',
    )),

    struct_pattern_field: $ => seq(
      field('name', $.identifier),
      optional(seq(':', field('pattern', $._pattern))),
    ),

    // `[]`, `[a, b]` — a list matched by exact length.
    list_pattern: $ => seq(
      '[',
      optional(sepBy1(',', $._pattern)),
      optional(','),
      ']',
    ),

    // `[...rest]`, `[a, ...]`, `[a, b, ...tail]` — head elements
    // followed by a rest that may be named, anonymous, or `_`.
    cons_pattern: $ => seq(
      '[',
      repeat(seq($._pattern, ',')),
      '...',
      optional(choice($.identifier, '_')),
      ']',
    ),

    // `Circle(r) as whole` — binds the whole matched value while
    // still destructuring it.  Binds tighter than `|` so that
    // `A(x) | B(x) as w` names the alternation, matching the
    // reference where `as` sits inside the or-pattern's operand.
    as_pattern: $ => prec.left(1, seq(
      $._pattern,
      'as',
      field('name', $.identifier),
    )),

    // `0x02 | 0x04 | 0x06` — multiple patterns matching the same
    // arm.  Lower prec than the others so the parser tries
    // single patterns first.
    or_pattern: $ => prec.left(0, seq(
      $._pattern, '|', $._pattern,
    )),

    // `(a, b)` / `(s, _)` — tuple pattern.  At least 2 elements
    // (single-element parens at pattern position are paren-grouped
    // sub-patterns; tree-sitter resolves via position-and-comma).
    tuple_pattern: $ => seq(
      '(',
      $._pattern,
      ',',
      optional(sepBy1(',', $._pattern)),
      optional(','),
      ')',
    ),

    wildcard_pattern: $ => '_',

    identifier_pattern: $ => prec(-1, $.identifier),

    literal_pattern: $ => choice(
      $.string_literal,
      $.char_literal,
      $.integer_literal,
      $.float_literal,
      // `-1`, `-2.5`: the sign is part of the literal.
      seq('-', choice($.integer_literal, $.float_literal)),
      $.bool_literal,
      $.none_literal,
    ),

    constructor_pattern: $ => prec(2, choice(
      seq($.identifier, '.', $.identifier, optional($._ctor_arg_list)),
      seq($.identifier, $._ctor_arg_list),
    )),

    _ctor_arg_list: $ => seq(
      '(',
      optional(sepBy1(',', $._pattern_arg)),
      optional(','),
      ')',
    ),

    _pattern_arg: $ => choice(
      seq($.identifier, ':', $._pattern),
      $._pattern,
    ),


    // ── Type expressions ───────────────────────────────────────
    _type_expr: $ => choice(
      $.optional_type,
      $.list_type,
      $.fixed_array_type,
      $.fn_type,
      $.tuple_type,
      $.generic_type,
      $.heapless_type,
      $.modifier_type,
      $.pointer_type,
      $.paren_type,
      $.unit_type,
      $.named_type,
    ),

    // The type after `->`: every type but the heapless list, whose
    // `[` would read as the start of the effect row that follows.
    _ret_type: $ => choice(
      $.optional_type,
      $.list_type,
      $.fixed_array_type,
      $.fn_type,
      $.tuple_type,
      $.generic_type,
      $.heapless_type,
      $.modifier_type,
      $.pointer_type,
      $.paren_type,
      $.unit_type,
      $.named_type,
    ),

    // `*T` / `*const T` — raw pointer types, used on the hardware
    // and FFI surfaces.
    pointer_type: $ => prec.right(seq(
      '*',
      optional('const'),
      $._type_expr,
    )),

    // `(T)` — parenthesised type.  Exists to separate a returned
    // function type from the enclosing declaration's effect row:
    // `-> (fn() -> Unit) [mutate]` returns a pure closure and is
    // itself `[mutate]`, where `-> fn() -> Unit [mutate]` binds the
    // row to the inner fn type.  Distinct from tuple_type, which
    // requires a comma.
    paren_type: $ => seq('(', $._type_expr, ')'),

    // `()` — the unit type, the other spelling of `Unit` (SPEC § 3.1):
    // `Result<(), E>` names the same type as `Result<Unit, E>`.  The
    // empty parentheses cannot be a parenthesised or a tuple type,
    // which hold at least one type.
    unit_type: $ => seq('(', ')'),

    // `weak T` (M30 weak ref) and `dyn T` (dynamic dispatch).
    modifier_type: $ => prec.right(seq(
      choice('weak', 'dyn'),
      $._type_expr,
    )),

    //
    // The four heapless-family names are tokens of their own (see
    // heapless_type), and a bare one is a name like any other:
    // `impl Collection for Deque` in the standard library names the
    // type without arguments.
    named_type: $ => prec.right(seq(
      choice(
        $.identifier,
        alias(choice('Vec', 'Deque', 'Map', 'String'), $.identifier),
      ),
      optional(seq('.', $.identifier)),
    )),

    // `[u8; 6]` — fixed-size array type.  Distinguishes from
    // list_type via the `;` separator + size literal.
    fixed_array_type: $ => seq(
      '[',
      field('element', $._type_expr),
      ';',
      field('size', $.integer_literal),
      ']',
    ),

    // `fn(Int) -> Int` — function type.  Used in higher-order fn
    // params (`fn apply(f: fn(Int) -> Int, x: Int)`).
    // A function type carries its effect row the same way a fn
    // header does: `fn(Str) -> Unit [io]`.  The row is part of the
    // type, so two fn types differing only in effects are distinct.
    fn_type: $ => prec.right(seq(
      'fn',
      '(',
      optional(sepBy1(',', $._type_expr)),
      optional(','),
      ')',
      optional(seq('->', $._ret_type)),
      optional(field('effects', $.effect_list)),
    )),

    // `(Int, Str)` — tuple type.  Requires at least one comma to
    // distinguish from `(T)` parenthesised type (rare, handled
    // by named_type wrapping anyway).
    tuple_type: $ => seq(
      '(',
      $._type_expr,
      ',',
      optional(sepBy1(',', $._type_expr)),
      optional(','),
      ')',
    ),

    // `Vec[T; N]` — the heapless family's inline-capacity list
    // (SPEC § 14.8): the element type and the capacity, separated by
    // `;` as in the fixed array type.
    // The heapless family of SPEC § 14.8: `Vec[T; N]` and `Deque[T; N]`,
    // `Map[K, V; N]` with its two element types, and `String[N]`, whose
    // one argument is the capacity.
    heapless_type: $ => prec.dynamic(2, choice(
      seq(
        alias(choice('Vec', 'Deque'), $.identifier),
        '[',
        field('element', $._type_expr),
        ';',
        field('capacity', $._expr),
        ']',
      ),
      seq(
        alias('Map', $.identifier),
        '[',
        field('key', $._type_expr),
        ',',
        field('element', $._type_expr),
        ';',
        field('capacity', $._expr),
        ']',
      ),
      seq(
        alias('String', $.identifier),
        '[',
        field('capacity', $._expr),
        ']',
      ),
    )),

    // `Foo<T, U>` — generic type instantiation.
    // `Volume<D>` and, qualified by its module, `nvfs.Volume<D>`: a
    // dependency's generic type is named through the module that
    // declares it, the way `nvfs.Volume` is without arguments.
    //
    // `Deque<T>` and `Map<K, V>` are the standard library's containers
    // (SPEC § 14.8), and the heapless rule above spells `Vec`, `Deque`,
    // `Map` and `String` as tokens of their own so that the `[` after
    // them can tell the inline family from a name.  The angle-bracket
    // form is the same name followed by `<`, so the generic type takes
    // the four tokens as names too and aliases them back to the
    // identifier node every other generic type has.
    generic_type: $ => prec.right(2, seq(
      choice(
        $.identifier,
        alias(choice('Vec', 'Deque', 'Map', 'String'), $.identifier),
      ),
      optional(seq('.', $.identifier)),
      '<',
      sepBy1(',', $._type_expr),
      '>',
    )),

    // `readonly [T]` and `readonly Bytes` — a function's answer that the
    // caller may read and never writes through (SPEC §4.3).  Only a
    // return type takes the word, and `readonly` is not reserved, so
    // it stays an identifier everywhere else.
    readonly_type: $ => seq(
      'readonly',
      choice($.list_type, $.named_type),
    ),

    optional_type: $ => seq('?', $._type_expr),

    list_type: $ => seq('[', $._type_expr, ']'),

    // ── Expressions (slice 5a — binary/unary operators + ??/|>) ─
    // Precedence ladder mirrors SPEC §6 (lowest → highest):
    //   1  or  (||)
    //   2  and (&&)
    //   3  comparisons  ==  !=  <  >  <=  >=
    //   4  bitwise or   |
    //   5  bitwise xor  ^
    //   6  bitwise and  &
    //   7  shifts       <<  >>  >>>
    //   8  add/sub      +  -        (str concat is the same +)
    //   9  mul/div/mod  *  /  %
    //  10  power        **          (right-assoc)
    //  11  unary        -  ~  not
    //  12  pipe         |>          (left-assoc)
    //  13  null-coalesce  ??        (right-assoc)
    //  14  postfix      .  ?.  []  ()  (field, safe-field, index, call)
    _expr: $ => choice(
      $.binary_expr,
      $.unary_expr,
      $.null_coalesce_expr,
      $.range_expr,
      $.pipe_expr,
      $.closure_expr,
      $.cast_expr,
      $.await_expr,
      $.if_expr,
      $.if_stmt,
      $.match_expr,
      $.call_expr,
      $.index_expr,
      $.field_access,
      $.unwrap_expr,
      $.struct_literal,
      $.paren_expr,
      $.unit_literal,
      $.tuple_expr,
      $.list_comprehension,
      $.list_literal,
      $.string_literal,
      $.fstring_literal,
      $.char_literal,
      $.integer_literal,
      $.float_literal,
      $.bool_literal,
      $.none_literal,
      $.self_expr,
      $.null_expr,
      $.bsp_ns,
      alias($._wrapping_name, $.identifier),
      alias($._frame_name, $.identifier),
      $.identifier,
    ),

    // `bsp.board.init()`.  `bsp` is a reserved word — it opens the
    // board declaration — AND it is the head of the `bsp.*` stdlib
    // module, which the reference parser admits explicitly
    // (`| BSP { EVar ("bsp", …) }` in parser.mly).  Without this the
    // grammar reads the word as the start of a declaration and the
    // call is an ERROR, which is what adding the keyword cost until
    // the escape came with it.  The other six embedded keywords have
    // no such escape in the reference parser, so none is given one
    // here.
    bsp_ns: $ => 'bsp',

    // `wrapping` read as a name: a function called `wrapping`, a
    // variable, a field.  Where a statement starts the word lexes as the
    // keyword `wrapping_stmt` opens with, so the name has to accept that
    // token too; it is aliased to `identifier`, and the tree is the one
    // any other name gets.
    _wrapping_name: $ => 'wrapping',

    // `frame` read as a name.  The reference lexer has no token for it:
    // the word is a declaration only when a second name and `=` follow
    // (`frame Name = Hdr ++ Body`), and a name everywhere else, because
    // `frame` is what a render function or a per-tick snapshot is
    // called.  Here the declaration's keyword is a token, so the name
    // has to accept it too; the one token of lookahead after it tells
    // `frame Name =` from `frame(...)`, `frame = ...` and a plain use,
    // and the result is aliased to `identifier`.
    _frame_name: $ => 'frame',

    // `match scrutinee\n    arm => ...` as an expression — used in
    // `let x = match ...` and similar.  Same shape as match_stmt
    // but without the trailing newline / dedent constraint that
    // statement-position matches honour.  prec.right keeps the
    // parser from merging an inline `match` into surrounding
    // operators.
    match_expr: $ => prec.right(seq(
      'match',
      field('scrutinee', $._expr),
      field('body', $.match_block),
    )),

    // `if cond then a else b` (single-line ternary form), with
    // optional `elif cond then x` chains:
    //   if a then b elif c then d elif e then f else g
    // Block form `if cond\n    body\nelse\n    body` is allowed
    // as an expression too (Novo uses it heavily for
    // `let x = if ...`); modelled via if_stmt and resolved by the
    // conflicts entry below.
    if_expr: $ => prec.right(seq(
      'if',   field('condition', $._expr),
      'then', field('then', $._expr),
      repeat(seq(
        'elif', $._expr,
        'then', $._expr,
      )),
      'else', field('else', $._expr),
    )),

    // `expr as TypeName` — type cast.  Same precedence band as
    // unary so `-x as Int` reads as `(-x) as Int`.
    cast_expr: $ => prec.left(11, seq(
      $._expr, 'as', $._type_expr,
    )),

    // `await fut` — awaits a future, bound at the unary level so
    // postfix calls / field access bind tighter (`await fut.x` is
    // `await (fut.x)`).  prec.right so `await x as T` reads as
    // `await (x as T)`.
    await_expr: $ => prec.right(11, seq('await', $._expr)),

    // `Foo { field: value, ... }` — struct literal with named
    // fields.  Higher precedence than identifier so the followup
    // `{ ... }` is recognised as part of the literal rather than
    // starting a new block (which doesn't exist as an expression
    // anyway, but tree-sitter's LR(1) needs the disambiguator).
    //
    // The type may carry one module qualifier, `csip.CoordSend { ... }`,
    // the spelling a literal of an imported struct takes.
    struct_literal: $ => choice(
      prec(15, seq(
        field('type', $.identifier),
        '{',
        optional(sepBy1(',', $.struct_literal_field)),
        optional(','),
        '}',
      )),
      seq(
        field('module', $.identifier),
        '.',
        field('type', $.identifier),
        '{',
        optional(sepBy1(',', $.struct_literal_field)),
        optional(','),
        '}',
      ),
    ),

    struct_literal_field: $ => seq(
      field('name', $.identifier),
      ':',
      field('value', $._expr),
    ),

    self_expr: $ => 'self',
    null_expr: $ => 'null',

    // Closure literal — `x => x * 2`, `(x, y) => x + y`, or
    // multi-line `x =>\n    body` with an indented block.  Used
    // as callback args (`nums.map(x => x * 2)`,
    // `xs.for_each(x =>\n    total = total + x\n)`).
    //
    // dynamic_prec(-1) makes tree-sitter prefer ANY other valid
    // parse over closure_expr.  Without this, `n if cond => body`
    // match arms greedily merge `cond` and `=>` into a closure
    // (`cond => body`) inside the guard expression, leaving the
    // arm itself MISSING its `=>` and falling into ERROR.
    closure_expr: $ => prec.right(prec.dynamic(-1, seq(
      field('params', choice(
        $.identifier,
        $.closure_params,
      )),
      '=>',
      choice(
        field('body', $._expr),
        field('body', $.assignment_stmt),
        field('body', $.block),
      ),
    ))),

    // Closure params share the `( ident, ident, ... )` shape with
    // paren_expr containing a bare identifier.  The disambiguator
    // is the `=>` token that follows; we tell tree-sitter to
    // resolve the conflict via the dynamic precedence on
    // closure_expr (when `=>` follows, prefer the closure path).
    closure_params: $ => prec.dynamic(1, seq(
      '(',
      optional(sepBy1(',', $.identifier)),
      optional(','),
      ')',
    )),

    paren_expr: $ => seq('(', $._expr, ')'),

    // `()` — the unit value.  Written as a match-arm body or a
    // do-nothing fn body.  Distinct from closure_params `()` by the
    // absence of a following `=>`, which the dynamic precedence on
    // closure_expr resolves.
    unit_literal: $ => prec(-1, seq('(', ')')),

    // `(a, b, c)` — tuple literal.  Distinct from paren_expr by
    // requiring at least one comma so single-element parens stay
    // as paren_expr (matching Novo where `(x)` is grouping, not
    // a 1-tuple).
    tuple_expr: $ => seq(
      '(',
      $._expr,
      ',',
      optional(sepBy1(',', $._expr)),
      optional(','),
      ')',
    ),

    // The operator tokens (`+`, `==`, `or`, etc.) get coloured via
    // anonymous-node matches in highlights.scm; we don't bother
    // wrapping them in a field() since tree-sitter doesn't surface
    // anonymous tokens as named children either way.
    // The bitwise and shift rows are Rust's order, not C's: shifts bind
    // tighter than `&`, `&` than `^`, `^` than `|`, and all four bind
    // tighter than the comparisons, so `a & b == c` is `(a & b) == c`.
    binary_expr: $ => choice(
      prec.left(1, seq($._expr, choice('or',  '||'), $._expr)),
      prec.left(2, seq($._expr, choice('and', '&&'), $._expr)),
      prec.left(3, seq($._expr, choice('==', '!=', '<', '>', '<=', '>='), $._expr)),
      prec.left(4, seq($._expr, '|',                                    $._expr)),
      prec.left(5, seq($._expr, '^',                                    $._expr)),
      prec.left(6, seq($._expr, '&',                                    $._expr)),
      prec.left(7, seq($._expr, choice('<<', '>>', '>>>'),              $._expr)),
      prec.left(8, seq($._expr, choice('+', '-'),                       $._expr)),
      prec.left(9, seq($._expr, choice('*', '/', '%'),                  $._expr)),
      prec.right(10, seq($._expr, '**',                                 $._expr)),
    ),

    unary_expr: $ => prec.right(11, seq(
      // `*` is the raw-pointer deref.  Safe as both a unary and a
      // binary operator for the same reason `-` is: numeric literals
      // lex unsigned, so after a complete expression the only action
      // on `*` is shift-as-binary, and the unary form is reachable
      // only from expression-start states.  `~` is the bitwise
      // complement and is prefix-only.
      choice('-', 'not', '!', '*', '~'),
      $._expr,
    )),

    pipe_expr: $ => prec.left(12, seq($._expr, '|>', $._expr)),

    null_coalesce_expr: $ => prec.right(13, seq($._expr, '??', $._expr)),

    // `a..b` (exclusive) and `a..=b` (inclusive).  Lower precedence
    // than arithmetic so `1..n+1` reads as `1..(n+1)`.  Also
    // supports unbounded forms: `..b`, `a..`, `..` — used in slice
    // syntax.
    range_expr: $ => choice(
      // Binary forms — higher prec so `1..10` parses as the
      // bounded range, not as `1..` + `10` (which would happen
      // with the unbounded form winning the LR lookahead).
      prec.left(2, seq($._expr, '..',  $._expr)),
      prec.left(2, seq($._expr, '..=', $._expr)),
      prec.left(1, seq('..', $._expr)),
      prec.left(1, seq($._expr, '..')),
    ),

    // Postfix family — calls, index, field access — all share the
    // top precedence so `f().x[0]` chains correctly.  Slice 5b
    // adds named-argument syntax (`Circle(radius: 5.0)`,
    // `f(x: 1, y: 2)`) — common in constructor calls.
    call_expr: $ => prec.left(14, seq(
      field('callee', $._expr),
      '(',
      optional(sepBy1(',', $._call_arg)),
      optional(','),
      ')',
    )),

    _call_arg: $ => choice(
      $.named_arg,
      $.var_arg,
      $._expr,
    ),

    named_arg: $ => prec(2, seq(
      field('name', $.identifier),
      ':',
      field('value', choice($._expr, $.var_arg)),
    )),

    // `bump(var n)` — the call-site marker of an in-out `var`
    // parameter (SPEC §4.3, §14.7): the argument is a place the
    // callee writes back into.
    var_arg: $ => seq(
      'var',
      field('value', $._expr),
    ),

    // `a[i]` is an index and `a[lo:hi:step]` a slice.  They share the
    // `value [` prefix, and the colon decides between them, so a slice
    // is the index's `index` child rather than a node of its own around
    // the whole postfix: an editor query that walks index_expr sees
    // both, and one that only wants slices asks for slice_expr.
    index_expr: $ => prec.left(14, seq(
      field('value', $._expr),
      '[',
      field('index', choice($._expr, $.slice_expr)),
      ']',
    )),

    // The inside of `a[lo:hi]`, `a[:hi]`, `a[lo:]`, `a[:]` and, with a
    // second colon, `a[lo:hi:step]` — SPEC § 6 "Slicing".  Every part
    // may be left out, so the one colon is the only token a slice
    // always has; `a[::-1]` is two colons with a step and no bounds.
    // It is only ever reached from index_expr, since a slice outside
    // brackets is not Novo.
    slice_expr: $ => seq(
      optional(field('start', $._expr)),
      ':',
      optional(field('stop', $._expr)),
      optional(seq(':', optional(field('step', $._expr)))),
    ),

    // `.` and `?.` (safe-navigation) field access.  The field is a
    // name, or a tuple position (`pair.0`, `pair.1`).  After the dot
    // the float token `.0` is not a valid lookahead, so the position
    // lexes as its own digits.
    field_access: $ => prec.left(14, seq(
      field('value', $._expr),
      choice('.', '?.'),
      field('field', choice($.identifier, alias(/[0-9]+/, $.tuple_index))),
    )),

    // `expr!` — postfix result unwrap.  Shares the postfix
    // precedence so `f(x)!.field` and `g()! * 2` chain correctly.
    // Distinct from the prefix `!` in unary_expr by position.
    unwrap_expr: $ => prec.left(14, seq(
      field('value', $._expr),
      '!',
    )),

    // An element is an expression or a splice `...xs`, the elements of a
    // list or fixed array spliced in place (SPEC §6.3).  Lists only: a
    // tuple, a call argument and a struct field have no splice.
    list_literal: $ => seq(
      '[',
      optional(sepBy1(',', choice($._expr, $.splice_element))),
      optional(','),
      ']',
    ),

    splice_element: $ => seq('...', $._expr),

    // `[ elem for pat in iter ]`, optionally `if guard` — SPEC §6.2.
    // Shares the whole `[ expr` prefix with the list literal above, so
    // the two are decided by the token after the first element: `for`
    // here, `,` or `]` there.  `prec(1, …)` states that preference
    // rather than leaving it to a `conflicts:` entry, matching the
    // reference parser, where one token of lookahead settles it.
    //
    // The field names are `for_stmt`'s, so the binder and the source
    // read the same in a comprehension as in the loop it lowers to and
    // the highlight/locals queries need no second spelling.
    list_comprehension: $ => prec(1, seq(
      '[',
      field('element', $._expr),
      'for',
      field('binder', $._pattern),
      'in',
      field('iter', $._expr),
      optional(seq('if', field('guard', $._expr))),
      ']',
    )),

    // ── Atoms ──────────────────────────────────────────────────
    identifier: $ => /[a-zA-Z_][a-zA-Z0-9_]*/,

    // Numeric literals are unsigned at the lexer level — leading `-`
    // is the unary_expr operator (slice 5a).  Otherwise `1 - 2`
    // would parse as `1` followed by the token `-2`, missing the
    // binary `-` interpretation entirely.
    // Integer literals — unsigned at the lex level (sign goes
    // through unary_expr).  Decimal, hex (`0xFF`), binary (`0b101`),
    // and octal (`0o755`) supported, with optional `_` separators
    // (`1_000_000`, `0xDEAD_BEEF`).
    integer_literal: $ => choice(
      /0[xX][0-9a-fA-F][0-9a-fA-F_]*/,
      /0[bB][01][01_]*/,
      /0[oO][0-7][0-7_]*/,
      /[0-9][0-9_]*/,
    ),

    // Float literals — `3.14`, `1e-9`, `2.5e10` (`5.` and `.5` not
    // accepted; needs a digit either side of the dot, or an explicit
    // exponent).  The compiler's lexer has no leading-dot float; one
    // here made `.0` of `r.0` the start of the next match arm's pattern
    // in `Some(r) => r.0`.
    float_literal: $ => choice(
      /[0-9][0-9_]*\.[0-9][0-9_]*([eE][+-]?[0-9]+)?/,
      /[0-9][0-9_]*[eE][+-]?[0-9]+/,
    ),

    // Character literal — `'c'`, `'\n'`, `'\xFF'`, `'\''`, `'"'`.  One char or
    // escape between single quotes; lexes to an Int code point in the compiler.
    // Made a single token so a `"` inside one (`'"'`) is consumed here and never
    // opens a string_literal.  Escape order matters — the longer forms
    // (`\u{...}` codepoint, then `\xHH` hex) precede the generic `\.`.
    char_literal: $ => token(seq(
      "'",
      choice(
        /\\u\{[0-9a-fA-F]+\}/,
        /\\x[0-9a-fA-F][0-9a-fA-F]/,
        /\\./,
        /[^'\\]/,
      ),
      "'",
    )),

    // String literal — `"..."` with `\\` and `\"` escapes.
    // Forbidden: `${` (which makes the string an f-string).  The
    // regex disambiguates from f-strings without lookahead by:
    //   - `[^"\\$]`     — plain content char
    //   - `\\.`         — backslash escape
    //   - `\$[^{"]`     — `$` followed by non-`{` non-`"` (so
    //                     `$x`, `$1`, `$ ` work; `${` fails)
    //   - `\$"` at end  — trailing `$` immediately before close
    // The trailing `\$?` lets `"price: $"` close cleanly without
    // consuming the closing quote.
    //
    // `\$` needs no new alternative: `\\.` already consumes it, so a
    // string containing `\${` lexes HERE and not as an f-string —
    // which is exactly right now that `\$` is a real escape meaning a
    // literal `$` with no interpolation (SPEC §1.5, V1-WAVE2 B8).
    // `"a\${b"` is a plain string; `"a${b}"` is an f-string.
    //
    // The multiline spelling, `"""..."""`, is the same node.  Its body
    // is raw (SPEC § 1.5, multiline strings): a backslash is an
    // ordinary character, `$ident` is text, and the string ends at the
    // first run of three quotes.  It is one lexeme, so a comment
    // spelling inside it is text, and the longest match tells it from
    // an empty string followed by a string: `"""a"""` is one token
    // of seven characters where `""` is two.  A `${...}` hole is part
    // of the lexeme without being parsed, which is the cost of one
    // token and fine for highlighting.
    string_literal: $ => choice(
      token(seq(
        '"',
        repeat(choice(
          /[^"\\$]/,
          /\\./,
          /\$[^{"\\]/,
          // `$` before an escape: the `$` is text and the escape is
          // its own unit, so `"b$\""` closes at the last quote and
          // not at the escaped one.
          /\$\\./,
        )),
        optional('$'),
        '"',
      )),
      token(seq('"""', /([^"]|"[^"]|""[^"])*/, '"""')),
    ),

    // F-string with `${expr}` interpolation.  Structured so
    // highlights.scm can colour the contained expressions
    // independently of the surrounding string text.  Lexer
    // disambiguation: any `"…${…}…"` source fails the
    // string_literal regex above (the `${` match fails because
    // `\$[^{"]` requires non-`{` next), so falls through here.
    fstring_literal: $ => seq(
      $._fstring_open,
      repeat(choice(
        $.fstring_segment,
        $.fstring_interp,
      )),
      $._fstring_close,
    ),

    // Literal `"` opening / closing tokens for f-strings.  Marked
    // hidden because the structural rule's bracket boundaries
    // aren't useful at the highlight level (highlights match the
    // outer fstring_literal node).
    _fstring_open:  $ => '"',
    _fstring_close: $ => token.immediate('"'),

    // `fstring_segment` — the plain text inside an f-string between
    // `${...}` interps — is an EXTERNAL token.  See `externals` at the
    // top of this file and the scanned-region branch in
    // src/scanner.c: a region is the only shape `extras` cannot enter,
    // and everything between the quotes is string content.

    fstring_interp: $ => seq(
      token.immediate('${'),
      field('expr', choice($._expr, alias($._hole_tuple, $.tuple_expr))),
      // The spec may be empty — the split at the top-level `:` is
      // positional, so `"${y:}"` is a hole with an empty spec, not
      // a syntax error.
      optional(seq(':', optional(field('format', $.fstring_format_spec)))),
      '}',
    ),

    // `${a, b}` — a top-level comma inside a hole makes the hole a
    // tuple, written without the parentheses a tuple has elsewhere
    // (SPEC § 1.5).  It gets the tuple node, so the tree reads as the
    // parenthesised spelling does.
    _hole_tuple: $ => seq($._expr, ',', sepBy1(',', $._expr), optional(',')),

    // `fstring_format_spec` — the opaque run after `:` inside
    // `${expr:fmt}`, up to the closing `}` — is an EXTERNAL token, for
    // the same reason `fstring_segment` is.  Examples: `5`
    // (right-align width 5), `<5` (left-align), `^5` (center), `0.2f`,
    // `#x` (hexadecimal with the prefix).  Slice 5j may structurally
    // parse the spec; today it is one region.

    bool_literal: $ => choice('true', 'false'),

    none_literal: $ => 'None',
  },
});

// Annotations and `pub`, in either order, for a declaration that takes
// both.
//
// `pub` marks the declaration part of the package's public surface.  It
// was missing from this grammar entirely until 2026-09-08, which did
// not read as an error: `pub` matched the identifier rule, so every
// public declaration silently parsed as a bare expression statement
// followed by the declaration.
//
// The two may be written in EITHER order, and a run of annotations on
// each side concatenates - the reference reads `PUB decl` and
// `annotation_list PUB decl` alike.  This grammar accepted only
// annotations BEFORE `pub`, so `pub @value` - which is the form
// `novo fmt` prints, and therefore the form nearly every annotated
// `pub` declaration in the tree is written in - fell back to the same
// silent mis-parse `pub` itself used to.
//
// Written as a `choice` rather than two adjacent `optional(repeat1(...))`
// because those are ambiguous when `pub` is absent: `tree-sitter
// generate` refuses them with "Unresolved conflict for symbol sequence:
// <decl>_repeat1 <decl>_repeat1".  With the `pub` between them there is
// one split point and no ambiguity, and the no-`pub` branch carries a
// single run.
function attrsAndPub($) {
  return choice(
    seq(
      optional(field('attrs', repeat1($.attribute))),
      field('visibility', 'pub'),
      optional(field('attrs', repeat1($.attribute))),
    ),
    optional(field('attrs', repeat1($.attribute))),
  );
}

function sepBy1(sep, rule) {
  return seq(rule, repeat(seq(sep, rule)));
}

function sepBy(sep, rule) {
  return optional(sepBy1(sep, rule));
}
