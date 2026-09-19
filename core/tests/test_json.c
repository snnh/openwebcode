/* C-level regression test for owc_json_get_int: a JSON number that is not
 * representable as an int must take the caller's fallback instead of being
 * cast.  Converting an out-of-range double to int is undefined behavior
 * (x86 produces INT_MIN for 1e300, so callers silently saw a bogus value
 * instead of a signal), and a silent truncation of 2.5 hides unit errors. */
#include "json.h"

#include <limits.h>
#include <stdio.h>
#include <string.h>

static int expect_int(const owc_json *root, const char *key, int fallback, int expected) {
    const owc_json *value = owc_json_object_get(root, key);
    int actual = owc_json_get_int(value, fallback);
    if (actual != expected) {
        (void)fprintf(stderr, "owc_json_get_int(%s, %d) = %d, expected %d\n",
                      key, fallback, actual, expected);
        return 0;
    }
    return 1;
}

int main(void) {
    static const char text[] =
        "{\"small\":7,\"negative\":-13,\"min\":-2147483648,\"max\":2147483647,"
        "\"over\":2147483648,\"way_over\":1e300,\"fraction\":2.5,"
        "\"tiny_fraction\":0.25,\"string\":\"12\",\"boolean\":true,"
        "\"null\":null,\"exact_float\":3.0}";
    const char *error_at = NULL;
    owc_json *root = owc_json_parse(text, strlen(text), &error_at);
    int ok = 1;
    if (!root) {
        (void)fprintf(stderr, "parse failed at %.20s\n", error_at ? error_at : "?");
        return 1;
    }
    ok = ok && expect_int(root, "small", -1, 7);
    ok = ok && expect_int(root, "negative", -1, -13);
    ok = ok && expect_int(root, "min", 0, INT_MIN);
    ok = ok && expect_int(root, "max", 0, INT_MAX);
    /* Out of range: fallback, never a wrapped or undefined value. */
    ok = ok && expect_int(root, "over", -99, -99);
    ok = ok && expect_int(root, "way_over", -99, -99);
    /* Not integral: fallback (the old cast silently truncated). */
    ok = ok && expect_int(root, "fraction", -99, -99);
    ok = ok && expect_int(root, "tiny_fraction", -99, -99);
    /* Wrong JSON type: unchanged fallback path. */
    ok = ok && expect_int(root, "string", -99, -99);
    ok = ok && expect_int(root, "boolean", -99, -99);
    ok = ok && expect_int(root, "null", -99, -99);
    ok = ok && expect_int(root, "missing", -99, -99);
    /* An integral double stays convertible. */
    ok = ok && expect_int(root, "exact_float", -99, 3);
    if (owc_json_get_int(NULL, -7) != -7) {
        (void)fprintf(stderr, "NULL value must take the fallback\n");
        ok = 0;
    }
    owc_json_free(root);
    if (!ok) return 2;
    (void)printf("json helpers: ok\n");
    return 0;
}
