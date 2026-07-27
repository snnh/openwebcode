#ifndef OWC_SYMBOL_EXTRACT_H
#define OWC_SYMBOL_EXTRACT_H

#include <stddef.h>

/* Lightweight per-language symbol extraction for the index.extract job.
 * This is a pure-C port of the server-side heuristic extractor
 * (server/src/index/symbols.ts): single-line anchored matchers, no regex
 * engine, no external dependencies.  The extraction operates on an
 * in-memory UTF-8 buffer; all file IO and policy checks live in rpc.c. */

/* Files larger than this are skipped by the job (same 1 MiB cap as the
 * TypeScript MAX_EXTRACT_FILE_BYTES). */
#define OWC_SYMBOL_MAX_FILE_BYTES (1024u * 1024u)
/* Default per-file symbol cap (TypeScript MAX_SYMBOLS_PER_FILE). */
#define OWC_SYMBOL_DEFAULT_MAX_PER_FILE 200u
/* Lines longer than this are skipped (minified/generated guard). */
#define OWC_SYMBOL_MAX_LINE 2000u
/* Signature digest length: trimmed line, first 120 bytes. */
#define OWC_SYMBOL_SIGNATURE_LIMIT 120u

typedef struct {
    char *name;        /* owned */
    char *signature;   /* owned */
    const char *kind;  /* static string: function|method|class|interface|type|struct|enum|trait|impl|constant */
    size_t start_line; /* 1-based, inclusive */
    size_t end_line;   /* 1-based, inclusive; next symbol start-1, last symbol runs to end of file */
} owc_symbol_record;

/* Maps a file path extension to a language name; NULL when unsupported.
 * Supported: typescript, javascript, python, go, rust, c, cpp, java, csharp. */
const char *owc_symbol_language_for_path(const char *path);

/* Extracts symbols from a UTF-8 text buffer (need not be NUL-terminated).
 * Returns 0 on success (records/count filled, possibly zero records) and
 * -1 on allocation failure.  Caller frees with owc_symbol_records_free. */
int owc_symbol_extract(const char *language, const char *text, size_t length, size_t max_symbols, owc_symbol_record **records, size_t *count);

void owc_symbol_records_free(owc_symbol_record *records, size_t count);

#endif
