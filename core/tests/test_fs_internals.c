/* C-level regression tests for fs.c/fs_posix.c internals that the RPC
 * fixtures cannot observe directly:
 *
 *   1. Glob matching: the matcher must stay equivalent to the historical
 *      recursive semantics while no longer backtracking exponentially on
 *      patterns like "*a*a*a*a*a*a*a*a*a*b".
 *   2. Deny roots: the configured deny list is thread-local (same contract as
 *      the Windows backend), so a background job worker publishing its own
 *      session policy must not change what the RPC dispatch thread enforces.
 *      The regression: with a process-wide list, the worker's publish made the
 *      main thread reject (and the worker's inode entry could equally let
 *      through) files it had no deny root for - hard links alias a denied
 *      inode under a second name, which is exactly how a deny was bypassed.
 */
#include "fs.h"
#include "platform/fs_platform.h"

#include <errno.h>
#include <fcntl.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

/* --- 1. glob matcher ---------------------------------------------------- */

/* Reference implementation: the original recursive matcher, kept verbatim so
 * the two can be compared exhaustively on every generated case. */
static int reference_wildcard(const char *pattern, const char *value) {
    while (*pattern) {
        if (*pattern == '*') {
            while (*pattern == '*') pattern++;
            if (!*pattern) return 1;
            while (*value) {
                if (reference_wildcard(pattern, value)) return 1;
                value++;
            }
            return 0;
        }
        if (*pattern == '?' && *value) { pattern++; value++; continue; }
        if (*pattern != *value) return 0;
        pattern++;
        value++;
    }
    return *value == '\0';
}

static int check_pair(const char *pattern, const char *value) {
    int expected = reference_wildcard(pattern, value);
    int actual = owc_fs_match_pattern(pattern, value);
    if (expected != actual) {
        (void)fprintf(stderr,
                      "glob mismatch: pattern=%s value=%s recursive=%d iterative=%d\n",
                      pattern, value, expected, actual);
        return 0;
    }
    return 1;
}

static int test_glob_equivalence(void) {
    static const char *const patterns[] = {
        "*", "*.*", "*.c", "src/*", "src/*/*.c", "a*b*c*", "?a?", "*a*a*a",
        "a*a*a*a*a", "**", "**.txt", "x?", "?*?", "abc", "", "a\\*b",
        "*?*?*?", "*.tar.gz", "*[a]", "dir/**/*.md", "a*b*c*d*e*f"
    };
    static const char *const values[] = {
        "", "a", "ab", "abc", "abcd", "abcde", "abcdeff", "aaaaaaaaaa",
        "aXaXaXa", "src", "src/", "src/main.c", "src/sub/main.c", "x.txt",
        ".env", "a.b.c", "dir/sub/dir/file.md", "*.txt", "aaabbbccc"
    };
    size_t i, j;
    for (i = 0; i < sizeof(patterns) / sizeof(patterns[0]); i++)
        for (j = 0; j < sizeof(values) / sizeof(values[0]); j++)
            if (!check_pair(patterns[i], values[j])) return 0;
    /* Byte semantics: '/' is an ordinary byte, not a separator. */
    if (!owc_fs_match_pattern("*.c", "src/a.c")) return 0;
    if (!owc_fs_match_pattern("a?c", "abc")) return 0;
    if (owc_fs_match_pattern("a?c", "ac")) return 0;
    if (!owc_fs_match_pattern("a*c", "ac")) return 0;
    return 1;
}

static int test_glob_budget(void) {
    /* The pathological shape: many '*a' groups against a long run of 'a's with
     * no match.  The recursive matcher explores every grouping of the stars
     * (exponential); the iterative one finishes in microseconds.  50 stars and
     * 200 characters would need >2^40 steps for the old code, so a 5 second
     * wall-clock bound is generous for the fixed version and impossible for
     * the old one. */
    char pattern[160], value[201];
    struct timespec started, finished;
    size_t i;
    long long elapsed_ms;
    for (i = 0; i < 50; i++) {
        pattern[i * 2] = '*';
        pattern[i * 2 + 1] = 'a';
    }
    pattern[100] = 'b';
    pattern[101] = '\0';
    memset(value, 'a', sizeof(value) - 1);
    value[sizeof(value) - 1] = '\0';
    if (clock_gettime(CLOCK_MONOTONIC, &started) != 0) return 0;
    /* No reference comparison here: the recursive matcher would need minutes
     * to answer this case (that is the bug); equivalence is covered by the
     * small patterns above, this case only pins the iterative answer. */
    if (owc_fs_match_pattern(pattern, value) != 0) return 0;
    if (clock_gettime(CLOCK_MONOTONIC, &finished) != 0) return 0;
    elapsed_ms = (long long)(finished.tv_sec - started.tv_sec) * 1000 +
                 (finished.tv_nsec - started.tv_nsec) / 1000000;
    if (elapsed_ms > 5000) {
        (void)fprintf(stderr, "glob matcher took %lld ms on a backtracing pattern\n", elapsed_ms);
        return 0;
    }
    return 1;
}

/* --- 2. thread-local deny roots ---------------------------------------- */

#define DENY_SOURCE "secret.txt"
#define DENY_ALIAS "alias.txt"

typedef struct {
    char source[4096];
    char alias_root[4096];
    const char *roots[1];
    pthread_mutex_t lock;
    pthread_cond_t cond;
    int published;
    int inspected;
    int worker_deny_hit;   /* worker thread saw its own deny root */
    int worker_deny_ok;
    int done;
} deny_thread_ctx;

static void *deny_worker(void *argument) {
    deny_thread_ctx *ctx = (deny_thread_ctx *)argument;
    owc_fs_bytes bytes = {0};
    owc_fs_error error;
    ctx->roots[0] = ctx->source;
    owc_fs_platform_set_deny_roots(ctx->roots, 1);
    (void)pthread_mutex_lock(&ctx->lock);
    ctx->published = 1;
    (void)pthread_cond_broadcast(&ctx->cond);
    while (!ctx->inspected) (void)pthread_cond_wait(&ctx->cond, &ctx->lock);
    (void)pthread_mutex_unlock(&ctx->lock);
    /* Positive control on this thread: its own published deny root must reject
     * the hard-linked alias by inode. */
    error = owc_fs_platform_read(ctx->alias_root, DENY_ALIAS, &bytes);
    ctx->worker_deny_hit = error == OWC_FS_OUTSIDE_ROOT;
    ctx->worker_deny_ok = error == OWC_FS_OK;
    free(bytes.data);
    owc_fs_platform_set_deny_roots(NULL, 0);
    (void)pthread_mutex_lock(&ctx->lock);
    ctx->done = 1;
    (void)pthread_cond_broadcast(&ctx->cond);
    (void)pthread_mutex_unlock(&ctx->lock);
    return NULL;
}

static int test_deny_roots_thread_local(void) {
    char template_a[] = "/tmp/owc-fs-deny-a-XXXXXX";
    char template_b[] = "/tmp/owc-fs-deny-b-XXXXXX";
    char *root_a, *root_b;
    char source[4096], alias[4096];
    deny_thread_ctx ctx;
    owc_fs_bytes bytes = {0};
    owc_fs_error error;
    pthread_t worker;
    int result = 0;

    root_a = mkdtemp(template_a);
    root_b = mkdtemp(template_b);
    if (!root_a || !root_b) return 0;
    (void)snprintf(source, sizeof(source), "%s/%s", root_a, DENY_SOURCE);
    (void)snprintf(alias, sizeof(alias), "%s/%s", root_b, DENY_ALIAS);
    {
        int handle = open(source, O_WRONLY | O_CREAT | O_TRUNC, 0600);
        if (handle < 0) { result = 0; goto cleanup; }
        if (write(handle, "denied-content", 14) != 14) { (void)close(handle); goto cleanup; }
        (void)close(handle);
    }
    if (link(source, alias) != 0) {
        (void)fprintf(stderr, "hard link unavailable (%s); test needs one filesystem\n", strerror(errno));
        goto cleanup;
    }
    memset(&ctx, 0, sizeof(ctx));
    if (pthread_mutex_init(&ctx.lock, NULL) != 0 || pthread_cond_init(&ctx.cond, NULL) != 0) goto cleanup;
    (void)snprintf(ctx.source, sizeof(ctx.source), "%s", source);
    (void)snprintf(ctx.alias_root, sizeof(ctx.alias_root), "%s", root_b);
    if (pthread_create(&worker, NULL, deny_worker, &ctx) != 0) goto cleanup;

    /* The main thread never publishes deny roots, so its reads must be
     * unaffected by the worker's publish (the old process-wide list made this
     * read fail with OWC_FS_OUTSIDE_ROOT). */
    (void)pthread_mutex_lock(&ctx.lock);
    while (!ctx.published) (void)pthread_cond_wait(&ctx.cond, &ctx.lock);
    (void)pthread_mutex_unlock(&ctx.lock);
    error = owc_fs_platform_read(root_b, DENY_ALIAS, &bytes);
    result = error == OWC_FS_OK && bytes.length == 14 &&
             memcmp(bytes.data, "denied-content", 14) == 0;
    if (!result)
        (void)fprintf(stderr,
                      "main-thread read of an unrelated hard link was affected by a worker's deny roots (error=%d)\n",
                      (int)error);
    free(bytes.data);
    bytes.data = NULL;
    (void)pthread_mutex_lock(&ctx.lock);
    ctx.inspected = 1;
    (void)pthread_cond_broadcast(&ctx.cond);
    while (!ctx.done) (void)pthread_cond_wait(&ctx.cond, &ctx.lock);
    (void)pthread_mutex_unlock(&ctx.lock);
    (void)pthread_join(worker, NULL);
    if (result && !ctx.worker_deny_hit) {
        (void)fprintf(stderr,
                      "worker thread did not enforce its own deny root (deny_ok=%d)\n",
                      ctx.worker_deny_ok);
        result = 0;
    }
    (void)pthread_cond_destroy(&ctx.cond);
    (void)pthread_mutex_destroy(&ctx.lock);
cleanup:
    /* Deny roots are gone with their thread; the main thread holds none. */
    (void)unlink(alias);
    (void)unlink(source);
    (void)rmdir(root_a);
    (void)rmdir(root_b);
    return result;
}

int main(void) {
    if (!test_glob_equivalence()) {
        (void)fprintf(stderr, "glob equivalence test failed\n");
        return 1;
    }
    if (!test_glob_budget()) {
        (void)fprintf(stderr, "glob budget test failed\n");
        return 2;
    }
    if (!test_deny_roots_thread_local()) {
        (void)fprintf(stderr, "deny root thread-locality test failed\n");
        return 3;
    }
    (void)printf("fs internals: ok\n");
    return 0;
}
