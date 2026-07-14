#ifndef OWC_JSON_H
#define OWC_JSON_H

#include <stddef.h>

typedef enum {
    OWC_JSON_NULL,
    OWC_JSON_BOOL,
    OWC_JSON_NUMBER,
    OWC_JSON_STRING,
    OWC_JSON_ARRAY,
    OWC_JSON_OBJECT
} owc_json_type;

typedef struct owc_json owc_json;

struct owc_json {
    owc_json_type type;
    char *key;
    union {
        int boolean;
        double number;
        char *string;
        struct { owc_json **items; size_t count; } children;
    } value;
};

owc_json *owc_json_parse(const char *text, size_t length, const char **error_at);
void owc_json_free(owc_json *value);
const owc_json *owc_json_object_get(const owc_json *object, const char *key);
const char *owc_json_get_string(const owc_json *value);
int owc_json_get_int(const owc_json *value, int fallback);
int owc_json_get_bool(const owc_json *value, int fallback);
char *owc_json_escape_string(const char *value);

#endif
