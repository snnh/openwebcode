#include "symbol_extract.h"

#include <stdlib.h>
#include <string.h>

/* Pure-C port of the former server/src/index/symbols.ts (since removed).
 * Every rule of the TypeScript regex-based extractor is rewritten as a
 * hand-rolled single-line matcher; all patterns are line-start anchored
 * and never look past the current line.  Matching semantics (rule order,
 * reject conditions, name capture, kind mapping) were kept in lockstep
 * with the original TypeScript version. */

typedef struct {
    size_t name_off;   /* byte offset of the name within the line */
    size_t name_len;
    size_t line;       /* 1-based line number */
    const char *kind;  /* static string */
} raw_match;

typedef struct {
    const char *s;     /* line start */
    const char *end;   /* one past the last line byte (excluding '\n') */
} line_span;

static int is_ws(char c) { return c == ' ' || c == '\t' || c == '\r' || c == '\f' || c == '\v'; }
static int is_alpha_(char c) { return (c >= 'A' && c <= 'Z') || (c >= 'a' && c <= 'z') || c == '_'; }
static int is_digit(char c) { return c >= '0' && c <= '9'; }
/* [A-Za-z_]\w* identifiers (python/go/rust/c-family/java/csharp). */
static int is_ident_start(char c) { return is_alpha_(c); }
static int is_ident(char c) { return is_alpha_(c) || is_digit(c); }
/* [A-Za-z_$][\w$]* identifiers (typescript/javascript). */
static int is_js_ident_start(char c) { return is_alpha_(c) || c == '$'; }
static int is_js_ident(char c) { return is_alpha_(c) || is_digit(c) || c == '$'; }

static const char *skip_ws(const char *p, const char *end) {
    while (p < end && is_ws(*p)) p++;
    return p;
}

/* Consumes a literal word; returns the position after it or NULL. */
static const char *consume(const char *p, const char *end, const char *word) {
    size_t n = strlen(word);
    if ((size_t)(end - p) >= n && !memcmp(p, word, n)) return p + n;
    return NULL;
}

/* The "kw\s+" pattern: literal keyword followed by one or more
 * whitespace characters; returns the position after the whitespace run
 * or NULL when the keyword (with trailing whitespace) is absent. */
static const char *consume_kw_ws(const char *p, const char *end, const char *word) {
    const char *q = consume(p, end, word);
    if (!q || q == end || !is_ws(*q)) return NULL;
    return skip_ws(q, end);
}

/* Word with a trailing \b boundary: next byte must be non-identifier or end. */
static const char *consume_kw_boundary(const char *p, const char *end, const char *word) {
    const char *q = consume(p, end, word);
    if (!q) return NULL;
    if (q < end && is_ident(*q)) return NULL;
    return q;
}

/* Parses an identifier at p; on success returns the position after it
 * and stores the identifier length.  js selects the [\w$] alphabet. */
static const char *parse_ident(const char *p, const char *end, int js, size_t *length) {
    const char *q;
    if (p == end) return NULL;
    if (js ? !is_js_ident_start(*p) : !is_ident_start(*p)) return NULL;
    q = p + 1;
    while (q < end && (js ? is_js_ident(*q) : is_ident(*q))) q++;
    *length = (size_t)(q - p);
    return q;
}

static int is_c_keyword(const char *name, size_t length) {
    static const char *const keywords[] = {
        "if", "for", "while", "switch", "return", "sizeof", "catch", "do", "else",
        "typedef", "static", "extern", "inline", "const", "volatile", "register",
    };
    size_t i;
    for (i = 0; i < sizeof(keywords) / sizeof(keywords[0]); i++)
        if (strlen(keywords[i]) == length && !memcmp(name, keywords[i], length)) return 1;
    return 0;
}

static void set_match(raw_match *match, const line_span *line, const char *name, size_t name_len, const char *kind) {
    match->name_off = (size_t)(name - line->s);
    match->name_len = name_len;
    match->kind = kind;
}

/* ------------------------------------------------------------------ */
/* TypeScript / JavaScript (shared rule set).                          */
/* ------------------------------------------------------------------ */

static int match_typescript(const line_span *line, raw_match *match) {
    const char *s = line->s, *end = line->end;
    const char *p, *q, *name;
    size_t name_len;

    /* ^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*(ident)\s*\( */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "export")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "default")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "async")) != NULL) p = q;
    if ((q = consume(p, end, "function")) != NULL) {
        const char *r = skip_ws(q, end);
        if (r < end && *r == '*') r = skip_ws(r + 1, end);
        name = r;
        if ((r = parse_ident(r, end, 1, &name_len)) != NULL) {
            r = skip_ws(r, end);
            if (r < end && *r == '(') { set_match(match, line, name, name_len, "function"); return 1; }
        }
    }

    /* ^\s*(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(ident) */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "export")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "default")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "abstract")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "class")) != NULL) {
        name = q;
        if (parse_ident(q, end, 1, &name_len)) { set_match(match, line, name, name_len, "class"); return 1; }
    }

    /* ^\s*(?:export\s+)?interface\s+(ident) */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "export")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "interface")) != NULL) {
        name = q;
        if (parse_ident(q, end, 1, &name_len)) { set_match(match, line, name, name_len, "interface"); return 1; }
    }

    /* ^\s*(?:export\s+)?type\s+(ident)\s*[=<] */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "export")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "type")) != NULL) {
        const char *r;
        name = q;
        if ((r = parse_ident(q, end, 1, &name_len)) != NULL) {
            r = skip_ws(r, end);
            if (r < end && (*r == '=' || *r == '<')) { set_match(match, line, name, name_len, "type"); return 1; }
        }
    }

    /* ^\s*(?:export\s+)?(?:const\s+)?enum\s+(ident) */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "export")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "const")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "enum")) != NULL) {
        name = q;
        if (parse_ident(q, end, 1, &name_len)) { set_match(match, line, name, name_len, "enum"); return 1; }
    }

    /* ^\s*(?:export\s+)?(?:declare\s+)?const\s+(ident)\s*[=:] */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "export")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "declare")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "const")) != NULL) {
        const char *r;
        name = q;
        if ((r = parse_ident(q, end, 1, &name_len)) != NULL) {
            r = skip_ws(r, end);
            if (r < end && (*r == '=' || *r == ':')) { set_match(match, line, name, name_len, "constant"); return 1; }
        }
    }

    /* ^\s+(modifier)\s+(?:static\s+|async\s+|get\s+|set\s+)*(ident)\s*\( */
    if (s < end && is_ws(*s)) {
        static const char *const first_mods[] = {
            "public", "private", "protected", "static", "async", "override", "readonly", "get", "set",
        };
        static const char *const chain_mods[] = { "static", "async", "get", "set" };
        size_t i;
        p = skip_ws(s, end);
        for (i = 0; i < sizeof(first_mods) / sizeof(first_mods[0]); i++) {
            if ((q = consume_kw_ws(p, end, first_mods[i])) != NULL) {
                const char *r;
                p = q;
                for (;;) {
                    size_t j;
                    const char *next = NULL;
                    for (j = 0; j < sizeof(chain_mods) / sizeof(chain_mods[0]); j++)
                        if ((next = consume_kw_ws(p, end, chain_mods[j])) != NULL) break;
                    if (!next) break;
                    p = next;
                }
                name = p;
                if ((r = parse_ident(p, end, 1, &name_len)) != NULL) {
                    r = skip_ws(r, end);
                    if (r < end && *r == '(') { set_match(match, line, name, name_len, "method"); return 1; }
                }
                break; /* one alternation position only, as in the regex */
            }
        }
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Python.                                                             */
/* ------------------------------------------------------------------ */

static int match_python(const line_span *line, raw_match *match) {
    const char *s = line->s, *end = line->end;
    const char *p, *q, *name;
    size_t name_len;

    /* ^(\s*)(?:async\s+)?def\s+(ident)\s*\(  - indented def is a method */
    p = skip_ws(s, end);
    q = consume_kw_ws(p, end, "async");
    {
        const char *after_async = q ? q : p;
        const char *r = consume_kw_ws(after_async, end, "def");
        if (r) {
            name = r;
            if ((r = parse_ident(r, end, 0, &name_len)) != NULL) {
                r = skip_ws(r, end);
                if (r < end && *r == '(') {
                    set_match(match, line, name, name_len, p > s ? "method" : "function");
                    return 1;
                }
            }
        }
    }

    /* ^(\s*)class\s+(ident) */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "class")) != NULL) {
        name = q;
        if (parse_ident(q, end, 0, &name_len)) { set_match(match, line, name, name_len, "class"); return 1; }
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Go (rules anchored at column 0, no leading whitespace allowed).     */
/* ------------------------------------------------------------------ */

static int match_go(const line_span *line, raw_match *match) {
    const char *s = line->s, *end = line->end;
    const char *p, *name;
    size_t name_len;

    p = consume(s, end, "func");
    if (p && p < end && is_ws(*p)) {
        const char *r;
        p = skip_ws(p, end);
        /* ^func\s+\([^)]*\)\s*(ident)\s*\(  - method with receiver */
        if (p < end && *p == '(') {
            const char *close = p + 1;
            while (close < end && *close != ')') close++;
            if (close < end) {
                r = skip_ws(close + 1, end);
                name = r;
                if ((r = parse_ident(r, end, 0, &name_len)) != NULL) {
                    r = skip_ws(r, end);
                    if (r < end && *r == '(') { set_match(match, line, name, name_len, "method"); return 1; }
                }
            }
        }
        /* ^func\s+(ident)\s*\( */
        name = p;
        if ((r = parse_ident(p, end, 0, &name_len)) != NULL) {
            r = skip_ws(r, end);
            if (r < end && *r == '(') { set_match(match, line, name, name_len, "function"); return 1; }
        }
    }

    /* ^type\s+(ident)\s+(struct\b | interface\b | ...) */
    p = consume(s, end, "type");
    if (p && p < end && is_ws(*p)) {
        const char *r;
        p = skip_ws(p, end);
        name = p;
        if ((r = parse_ident(p, end, 0, &name_len)) != NULL && r < end && is_ws(*r)) {
            const char *after = skip_ws(r, end);
            if (consume_kw_boundary(after, end, "struct")) { set_match(match, line, name, name_len, "struct"); return 1; }
            if (consume_kw_boundary(after, end, "interface")) { set_match(match, line, name, name_len, "interface"); return 1; }
            set_match(match, line, name, name_len, "type");
            return 1;
        }
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Rust.                                                               */
/* ------------------------------------------------------------------ */

/* The optional (?:pub(?:\([^)]*\))?\s+)? prefix of the fn rule.
 * Returns the position after it, or p when the group is absent. */
static const char *rust_pub_scoped(const char *p, const char *end) {
    const char *q = consume(p, end, "pub");
    if (!q) return p;
    if (q < end && *q == '(') {
        const char *close = q + 1;
        while (close < end && *close != ')') close++;
        if (close == end) return p; /* (?:\([^)]*\))? needs the closing paren */
        q = close + 1;
    }
    if (q == end || !is_ws(*q)) return p; /* \s+ required by the group */
    return skip_ws(q, end);
}

static int match_rust(const line_span *line, raw_match *match) {
    const char *s = line->s, *end = line->end;
    const char *p, *q, *name;
    size_t name_len;

    /* ^\s*(?:pub(?:\([^)]*\))?\s+)?(?:async\s+)?fn\s+(ident) */
    p = skip_ws(s, end);
    q = rust_pub_scoped(p, end);
    {
        const char *r = consume_kw_ws(q, end, "async");
        const char *after_async = r ? r : q;
        if ((r = consume_kw_ws(after_async, end, "fn")) != NULL) {
            name = r;
            if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "function"); return 1; }
        }
    }

    /* ^\s*(?:pub\s+)?struct\s+(ident) / enum / trait variants */
    p = skip_ws(s, end);
    q = consume_kw_ws(p, end, "pub");
    {
        const char *after_pub = q ? q : p;
        const char *r;
        if ((r = consume_kw_ws(after_pub, end, "struct")) != NULL) {
            name = r;
            if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "struct"); return 1; }
        }
        if ((r = consume_kw_ws(after_pub, end, "enum")) != NULL) {
            name = r;
            if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "enum"); return 1; }
        }
        /* ^\s*(?:pub\s+)?(?:unsafe\s+)?trait\s+(ident) */
        r = consume_kw_ws(after_pub, end, "unsafe");
        {
            const char *after_unsafe = r ? r : after_pub;
            if ((r = consume_kw_ws(after_unsafe, end, "trait")) != NULL) {
                name = r;
                if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "trait"); return 1; }
            }
        }
    }

    /* ^\s*(?:unsafe\s+)?impl(?:<[^>]*>)?\s+(?:(?:path)[^{]*?\s+for\s+)?(ident)
     * The name is the impl'd type: "impl Trait for Type" yields Type. */
    p = skip_ws(s, end);
    q = consume_kw_ws(p, end, "unsafe");
    {
        const char *after_unsafe = q ? q : p;
        const char *r = consume(after_unsafe, end, "impl");
        if (r) {
            const char *first;
            size_t first_len = 0;
            if (r < end && *r == '<') {
                const char *close = r + 1;
                while (close < end && *close != '>') close++;
                if (close == end) return 0; /* generics group requires '>' */
                r = close + 1;
            }
            if (r == end || !is_ws(*r)) return 0;
            r = skip_ws(r, end);
            first = r;
            if (!parse_ident(r, end, 0, &first_len)) return 0;
            name = first;
            name_len = first_len;
            {
                /* Skip the rest of the first path ( ::ident segments ), then
                 * look for a whitespace-bounded "for" before any '{'. */
                const char *cursor = first + first_len;
                const char *scan;
                for (;;) {
                    const char *seg;
                    size_t seg_len = 0;
                    if (cursor + 1 >= end || cursor[0] != ':' || cursor[1] != ':') break;
                    seg = parse_ident(cursor + 2, end, 0, &seg_len);
                    if (!seg) break;
                    cursor = seg;
                }
                for (scan = cursor; scan < end && *scan != '{'; scan++) {
                    if (*scan == 'f' && scan > cursor && is_ws(scan[-1]) &&
                        (size_t)(end - scan) >= 3 && !memcmp(scan, "for", 3) &&
                        (scan + 3 == end || is_ws(scan[3]))) {
                        const char *t = skip_ws(scan + 3, end);
                        size_t t_len = 0;
                        if (parse_ident(t, end, 0, &t_len)) { name = t; name_len = t_len; }
                        break;
                    }
                }
            }
            set_match(match, line, name, name_len, "impl");
            return 1;
        }
    }

    /* ^\s*(?:pub\s+)?(?:const|static)\s+(ident) */
    p = skip_ws(s, end);
    q = consume_kw_ws(p, end, "pub");
    {
        const char *after_pub = q ? q : p;
        const char *r = consume_kw_ws(after_pub, end, "const");
        if (!r) r = consume_kw_ws(after_pub, end, "static");
        if (r) {
            name = r;
            if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "constant"); return 1; }
        }
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* C / C++ (shared rule set).                                          */
/* ------------------------------------------------------------------ */

/* Characters of the return-type prefix class [\w:<>,*&\[\]~ ] plus
 * whitespace (the class itself contains a space). */
static int is_c_prefix_char(char c) {
    if (is_ident(c)) return 1;
    if (is_ws(c)) return 1;
    return c == ':' || c == '<' || c == '>' || c == ',' || c == '*' || c == '&' ||
           c == '[' || c == ']' || c == '~';
}

/* Hand-rolled C_FUNCTION_RE:
 * ^\s*(?:[A-Za-z_][\w:<>,*&\[\]~ ]*?\s+)+([A-Za-z_]\w*)\s*\([^;{}]*\)\s*
 * (?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:->[^{;]+)?\{?\s*$
 * The prefix collapses to: non-empty, starts with [A-Za-z_], consists
 * only of prefix-class characters, and ends with whitespace before the
 * name (pointer returns like "char *f(" are rejected exactly like the
 * regex, which cannot place \s+ between '*' and the name). */
static int match_c_function(const line_span *line, raw_match *match) {
    const char *s = line->s, *end = line->end;
    const char *p, *e, *open, *re, *ne, *close, *q;
    size_t name_len;

    /* reject: ^\s*(#|//) and lines ending with ';' */
    p = skip_ws(s, end);
    if (p < end && (*p == '#' || (p + 1 < end && p[0] == '/' && p[1] == '/'))) return 0;
    e = end;
    while (e > s && is_ws(e[-1])) e--;
    if (e > s && e[-1] == ';') return 0;

    /* The name directly precedes the first '(' (prefix chars exclude '('). */
    open = p;
    while (open < end && *open != '(') open++;
    if (open == end) return 0;
    re = open;
    while (re > p && is_ws(re[-1])) re--;
    ne = re;
    while (ne > p && is_ident(ne[-1])) ne--;
    name_len = (size_t)(re - ne);
    if (!name_len || !is_ident_start(*ne)) return 0;
    /* reject: name is a control keyword */
    if (is_c_keyword(ne, name_len)) return 0;
    /* The (prefix\s+)+ region between the leading whitespace and the name. */
    if (ne == p) return 0;                 /* at least one prefix word required */
    if (!is_ws(ne[-1])) return 0;          /* prefix word must end with \s+ */
    if (!is_ident_start(*p)) return 0;     /* first prefix word starts [A-Za-z_] */
    for (q = p; q < ne; q++) if (!is_c_prefix_char(*q)) return 0;

    /* \([^;{}]*\) : last ')' before any ';', '{' or '}' after the open paren. */
    close = NULL;
    for (q = open + 1; q < end; q++) {
        if (*q == ';' || *q == '{' || *q == '}') break;
        if (*q == ')') close = q;
    }
    if (!close) return 0;

    /* \s*(?:const\s*)?(?:noexcept\s*)?(?:override\s*)?(?:->[^{;]+)?\{?\s*$ */
    q = skip_ws(close + 1, end);
    { const char *r = consume(q, end, "const"); if (r) q = skip_ws(r, end); }
    { const char *r = consume(q, end, "noexcept"); if (r) q = skip_ws(r, end); }
    { const char *r = consume(q, end, "override"); if (r) q = skip_ws(r, end); }
    if (q + 1 < end && q[0] == '-' && q[1] == '>') {
        const char *start = q + 2;
        q = start;
        while (q < end && *q != '{' && *q != ';') q++;
        if (q == start) return 0; /* -> requires at least one non-{; byte */
    }
    if (q < end && *q == '{') q++;
    q = skip_ws(q, end);
    if (q != end) return 0;
    set_match(match, line, ne, name_len, "function");
    return 1;
}

static int match_c_family(const line_span *line, raw_match *match) {
    const char *s = line->s, *end = line->end;
    const char *p, *q, *name;
    size_t name_len;

    if (match_c_function(line, match)) return 1;

    /* ^\s*(?:typedef\s+)?struct\s+(ident)\s*\{ */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "typedef")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "struct")) != NULL) {
        const char *r;
        name = q;
        if ((r = parse_ident(q, end, 0, &name_len)) != NULL) {
            r = skip_ws(r, end);
            if (r < end && *r == '{') { set_match(match, line, name, name_len, "struct"); return 1; }
        }
    }

    /* ^\s*(?:typedef\s+)?enum\s+(ident)\s*\{ */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "typedef")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "enum")) != NULL) {
        const char *r;
        name = q;
        if ((r = parse_ident(q, end, 0, &name_len)) != NULL) {
            r = skip_ws(r, end);
            if (r < end && *r == '{') { set_match(match, line, name, name_len, "enum"); return 1; }
        }
    }

    /* ^\s*(?:template\s*<[^>]*>\s*)?class\s+(ident) */
    p = skip_ws(s, end);
    if ((q = consume(p, end, "template")) != NULL) {
        const char *r = skip_ws(q, end);
        if (r < end && *r == '<') {
            const char *close = r + 1;
            while (close < end && *close != '>') close++;
            if (close < end) p = skip_ws(close + 1, end);
            /* missing '>': the optional group fails, "template" stays unmatched */
        }
    }
    if ((q = consume_kw_ws(p, end, "class")) != NULL) {
        name = q;
        if (parse_ident(q, end, 0, &name_len)) { set_match(match, line, name, name_len, "class"); return 1; }
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Java / C# methods share one shape; only the modifier list, the      */
/* trailing clause (throws/where) and the reject set differ.           */
/* ------------------------------------------------------------------ */

/* ^\s+(modifier)[\w<>\[\],.?\s]*?\s(ident)\s*\([^;]*\)\s*(?:clause\s+[^{]+)?\{?\s*$ */
static int match_jvm_method(const line_span *line, raw_match *match,
                            const char *const *mods, size_t mod_count,
                            const char *clause, int reject_new_return) {
    const char *s = line->s, *end = line->end;
    const char *p, *mend = NULL, *open, *re, *ne, *close, *q;
    size_t i, name_len;

    if (s == end || !is_ws(*s)) return 0;
    p = skip_ws(s, end);
    for (i = 0; i < mod_count; i++)
        if (consume(p, end, mods[i])) { mend = p + strlen(mods[i]); break; }
    if (!mend) return 0;

    /* The name directly precedes the first '(' after the modifier (the
     * middle character class excludes '('). */
    open = mend;
    while (open < end && *open != '(') open++;
    if (open == end) return 0;
    re = open;
    while (re > mend && is_ws(re[-1])) re--;
    ne = re;
    while (ne > mend && is_ident(ne[-1])) ne--;
    name_len = (size_t)(re - ne);
    if (!name_len || !is_ident_start(*ne)) return 0;
    if (ne == mend || !is_ws(ne[-1])) return 0; /* the explicit \s before the name */
    /* Middle characters between modifier and name: [\w<>\[\],.?\s]. */
    for (q = mend; q < ne; q++) {
        char c = *q;
        if (is_ident(c) || is_ws(c)) continue;
        if (c == '<' || c == '>' || c == '[' || c == ']' || c == ',' || c == '.' || c == '?') continue;
        return 0;
    }
    if (is_c_keyword(ne, name_len)) return 0;

    /* \([^;]*\) : last ')' before any ';' after the open paren. */
    close = NULL;
    for (q = open + 1; q < end; q++) {
        if (*q == ';') break;
        if (*q == ')') close = q;
    }
    if (!close) return 0;

    /* \s*(?:clause\s+[^{]+)?\{?\s*$ */
    q = skip_ws(close + 1, end);
    {
        const char *r = consume(q, end, clause);
        if (r && r < end && is_ws(*r)) {
            const char *start;
            q = skip_ws(r, end);
            start = q;
            while (q < end && *q != '{') q++;
            if (q == start) return 0; /* clause requires at least one non-{ byte */
        }
    }
    if (q < end && *q == '{') q++;
    q = skip_ws(q, end);
    if (q != end) return 0;

    /* reject: the text before the first occurrence of the name ends with
     * the word "new" or "return" (Java only). */
    if (reject_new_return) {
        const char *at;
        for (at = s; at + name_len <= end; at++) {
            if (!memcmp(at, ne, name_len)) break;
        }
        q = at;
        while (q > s && is_ws(q[-1])) q--;
        if (q - s >= 3 && !memcmp(q - 3, "new", 3) && (q - 3 == s || !is_ident(q[-4]))) return 0;
        if (q - s >= 6 && !memcmp(q - 6, "return", 6) && (q - 6 == s || !is_ident(q[-7]))) return 0;
    }
    set_match(match, line, ne, name_len, "method");
    return 1;
}

static int match_java(const line_span *line, raw_match *match) {
    static const char *const class_mods[] = { "public", "private", "protected", "abstract", "final", "static" };
    static const char *const method_mods[] = {
        "public", "private", "protected", "static", "final", "synchronized", "abstract", "default", "native",
    };
    const char *s = line->s, *end = line->end;
    const char *p, *q, *name;
    size_t name_len, i;

    /* ^\s*(modifier\s+)*class\s+(ident) */
    p = skip_ws(s, end);
    for (;;) {
        const char *next = NULL;
        for (i = 0; i < sizeof(class_mods) / sizeof(class_mods[0]); i++)
            if ((next = consume_kw_ws(p, end, class_mods[i])) != NULL) break;
        if (!next) break;
        p = next;
    }
    if ((q = consume_kw_ws(p, end, "class")) != NULL) {
        name = q;
        if (parse_ident(q, end, 0, &name_len)) { set_match(match, line, name, name_len, "class"); return 1; }
    }

    /* ^\s*(?:public\s+)?interface\s+(ident) */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "public")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "interface")) != NULL) {
        name = q;
        if (parse_ident(q, end, 0, &name_len)) { set_match(match, line, name, name_len, "interface"); return 1; }
    }

    /* ^\s*(?:public\s+)?enum\s+(ident) */
    p = skip_ws(s, end);
    if ((q = consume_kw_ws(p, end, "public")) != NULL) p = q;
    if ((q = consume_kw_ws(p, end, "enum")) != NULL) {
        name = q;
        if (parse_ident(q, end, 0, &name_len)) { set_match(match, line, name, name_len, "enum"); return 1; }
    }

    return match_jvm_method(line, match, method_mods, sizeof(method_mods) / sizeof(method_mods[0]), "throws", 1);
}

static int match_csharp(const line_span *line, raw_match *match) {
    static const char *const class_mods[] = {
        "public", "internal", "private", "protected", "abstract", "sealed", "static", "partial",
    };
    static const char *const method_mods[] = {
        "public", "private", "protected", "internal", "static", "async", "virtual",
        "override", "sealed", "readonly", "partial", "extern",
    };
    const char *s = line->s, *end = line->end;
    const char *p, *q, *name;
    size_t name_len, i;

    /* ^\s*(modifier\s+)*class\s+(ident) */
    p = skip_ws(s, end);
    for (;;) {
        const char *next = NULL;
        for (i = 0; i < sizeof(class_mods) / sizeof(class_mods[0]); i++)
            if ((next = consume_kw_ws(p, end, class_mods[i])) != NULL) break;
        if (!next) break;
        p = next;
    }
    if ((q = consume_kw_ws(p, end, "class")) != NULL) {
        name = q;
        if (parse_ident(q, end, 0, &name_len)) { set_match(match, line, name, name_len, "class"); return 1; }
    }

    /* ^\s*(?:public\s+|internal\s+)?(interface|struct|enum)\s+(ident) */
    p = skip_ws(s, end);
    q = consume_kw_ws(p, end, "public");
    if (!q) q = consume_kw_ws(p, end, "internal");
    {
        const char *after_mod = q ? q : p;
        const char *r;
        if ((r = consume_kw_ws(after_mod, end, "interface")) != NULL) {
            name = r;
            if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "interface"); return 1; }
        }
        if ((r = consume_kw_ws(after_mod, end, "struct")) != NULL) {
            name = r;
            if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "struct"); return 1; }
        }
        if ((r = consume_kw_ws(after_mod, end, "enum")) != NULL) {
            name = r;
            if (parse_ident(r, end, 0, &name_len)) { set_match(match, line, name, name_len, "enum"); return 1; }
        }
    }

    return match_jvm_method(line, match, method_mods, sizeof(method_mods) / sizeof(method_mods[0]), "where", 0);
}

/* ------------------------------------------------------------------ */
/* Language mapping and the per-file driver.                           */
/* ------------------------------------------------------------------ */

static int ext_equals(const char *ext, const char *word) {
    size_t i;
    for (i = 0;; i++) {
        char a = ext[i], b = word[i];
        if (a >= 'A' && a <= 'Z') a = (char)(a - 'A' + 'a');
        if (a != b) return 0;
        if (!a) return 1;
    }
}

const char *owc_symbol_language_for_path(const char *path) {
    const char *dot = NULL, *cursor, *ext;
    for (cursor = path; *cursor; cursor++)
        if (*cursor == '.') dot = cursor;
    if (!dot) return NULL;
    ext = dot + 1;
    if (ext_equals(ext, "ts") || ext_equals(ext, "tsx") || ext_equals(ext, "mts") || ext_equals(ext, "cts")) return "typescript";
    if (ext_equals(ext, "js") || ext_equals(ext, "jsx") || ext_equals(ext, "mjs") || ext_equals(ext, "cjs")) return "javascript";
    if (ext_equals(ext, "py") || ext_equals(ext, "pyi")) return "python";
    if (ext_equals(ext, "go")) return "go";
    if (ext_equals(ext, "rs")) return "rust";
    if (ext_equals(ext, "c") || ext_equals(ext, "h")) return "c";
    if (ext_equals(ext, "cpp") || ext_equals(ext, "cc") || ext_equals(ext, "cxx") ||
        ext_equals(ext, "hpp") || ext_equals(ext, "hh") || ext_equals(ext, "hxx")) return "cpp";
    if (ext_equals(ext, "java")) return "java";
    if (ext_equals(ext, "cs")) return "csharp";
    return NULL;
}

static int match_line(const char *language, const line_span *line, raw_match *match) {
    if (!strcmp(language, "typescript") || !strcmp(language, "javascript")) return match_typescript(line, match);
    if (!strcmp(language, "python")) return match_python(line, match);
    if (!strcmp(language, "go")) return match_go(line, match);
    if (!strcmp(language, "rust")) return match_rust(line, match);
    if (!strcmp(language, "c") || !strcmp(language, "cpp")) return match_c_family(line, match);
    if (!strcmp(language, "java")) return match_java(line, match);
    if (!strcmp(language, "csharp")) return match_csharp(line, match);
    return 0;
}

static char *copy_span(const char *start, size_t length) {
    char *copy = (char *)malloc(length + 1);
    if (!copy) return NULL;
    memcpy(copy, start, length);
    copy[length] = '\0';
    return copy;
}

void owc_symbol_records_free(owc_symbol_record *records, size_t count) {
    size_t i;
    if (!records) return;
    for (i = 0; i < count; i++) {
        free(records[i].name);
        free(records[i].signature);
    }
    free(records);
}

int owc_symbol_extract(const char *language, const char *text, size_t length, size_t max_symbols, owc_symbol_record **records, size_t *count) {
    raw_match *raw = NULL;
    owc_symbol_record *out = NULL;
    size_t raw_count = 0, total_lines = 1, i;

    *records = NULL;
    *count = 0;
    if (!language || !max_symbols) return 0;

    /* text.split("\n").length semantics: newline count + 1. */
    for (i = 0; i < length; i++)
        if (text[i] == '\n') total_lines++;

    raw = (raw_match *)malloc(max_symbols * sizeof(*raw));
    if (!raw) return -1;

    {
        const char *line_start = text;
        const char *end = text + length;
        size_t line_no = 1;
        const char *cursor;
        for (cursor = text; cursor <= end && raw_count < max_symbols; cursor++) {
            if (cursor == end || *cursor == '\n') {
                line_span line;
                raw_match match;
                line.s = line_start;
                line.end = cursor;
                if ((size_t)(line.end - line.s) <= OWC_SYMBOL_MAX_LINE &&
                    match_line(language, &line, &match)) {
                    match.line = line_no;
                    raw[raw_count++] = match;
                }
                line_no++;
                line_start = cursor + 1;
            }
        }
    }

    out = (owc_symbol_record *)calloc(raw_count ? raw_count : 1, sizeof(*out));
    if (!out) { free(raw); return -1; }
    for (i = 0; i < raw_count; i++) {
        const char *line_start = NULL, *sig_start, *sig_end;
        size_t sig_len, line_no = 1;
        const char *cursor;
        /* Re-locate the source line for the signature digest. */
        for (cursor = text; line_no <= raw[i].line; cursor++) {
            if (line_no == raw[i].line) { line_start = cursor; break; }
            if (*cursor == '\n') line_no++;
        }
        sig_start = line_start;
        sig_end = line_start;
        while (sig_end < text + length && *sig_end != '\n') sig_end++;
        while (sig_start < sig_end && is_ws(*sig_start)) sig_start++;
        while (sig_end > sig_start && is_ws(sig_end[-1])) sig_end--;
        sig_len = (size_t)(sig_end - sig_start);
        if (sig_len > OWC_SYMBOL_SIGNATURE_LIMIT) {
            sig_len = OWC_SYMBOL_SIGNATURE_LIMIT;
            /* Never split a UTF-8 multi-byte sequence at the cut point. */
            while (sig_len > 0 && (sig_start[sig_len] & 0xC0) == 0x80) sig_len--;
        }
        out[i].name = copy_span(line_start + raw[i].name_off, raw[i].name_len);
        out[i].signature = copy_span(sig_start, sig_len);
        if (!out[i].name || !out[i].signature) {
            owc_symbol_records_free(out, raw_count);
            free(raw);
            return -1;
        }
        out[i].kind = raw[i].kind;
        out[i].start_line = raw[i].line;
        out[i].end_line = i + 1 < raw_count ? raw[i + 1].line - 1 : total_lines;
    }
    free(raw);
    *records = out;
    *count = raw_count;
    return 0;
}
