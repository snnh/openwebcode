#include "json.h"

#include <ctype.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define OWC_JSON_MAX_DEPTH 128

typedef struct { const char *cursor; const char *end; const char *error; } parser;
typedef struct { char *data; size_t length; size_t capacity; } buffer;

static void skip_ws(parser *p) { while (p->cursor < p->end && isspace((unsigned char)*p->cursor)) p->cursor++; }
static void fail(parser *p) { if (!p->error) p->error = p->cursor; }

static int buffer_push(buffer *b, char ch) {
    if (b->length + 1 >= b->capacity) {
        size_t capacity = b->capacity ? b->capacity * 2 : 32;
        char *data = (char *)realloc(b->data, capacity);
        if (!data) return 0;
        b->data = data; b->capacity = capacity;
    }
    b->data[b->length++] = ch; b->data[b->length] = '\0'; return 1;
}

static int push_utf8(buffer *b, unsigned value) {
    if (value <= 0x7f) return buffer_push(b, (char)value);
    if (value <= 0x7ff) return buffer_push(b, (char)(0xc0 | (value >> 6))) && buffer_push(b, (char)(0x80 | (value & 0x3f)));
    if (value <= 0xffff) return buffer_push(b, (char)(0xe0 | (value >> 12))) && buffer_push(b, (char)(0x80 | ((value >> 6) & 0x3f))) && buffer_push(b, (char)(0x80 | (value & 0x3f)));
    return buffer_push(b, (char)(0xf0 | (value >> 18))) && buffer_push(b, (char)(0x80 | ((value >> 12) & 0x3f))) && buffer_push(b, (char)(0x80 | ((value >> 6) & 0x3f))) && buffer_push(b, (char)(0x80 | (value & 0x3f)));
}

static int parse_hex_quad(parser *p, unsigned *code) {
    int i;
    *code=0;
    if(p->end-p->cursor<4) { fail(p); return 0; }
    for(i=0;i<4;i++) {
        unsigned char ch=(unsigned char)*p->cursor++; int value;
        if(ch>='0' && ch<='9') value=ch-'0'; else if(ch>='a' && ch<='f') value=ch-'a'+10; else if(ch>='A' && ch<='F') value=ch-'A'+10; else { fail(p); return 0; }
        *code=*code*16u+(unsigned)value;
    }
    return 1;
}

static char *parse_string(parser *p) {
    buffer b = {0};
    if (p->cursor >= p->end || *p->cursor++ != '"') { fail(p); return NULL; }
    while (p->cursor < p->end) {
        unsigned char ch = (unsigned char)*p->cursor++;
        if (ch == '"') return b.data ? b.data : (char *)calloc(1, 1);
        if (ch < 0x20) { fail(p); break; }
        if (ch != '\\') { if (!buffer_push(&b, (char)ch)) break; continue; }
        if (p->cursor >= p->end) { fail(p); break; }
        ch = (unsigned char)*p->cursor++;
        if (ch == '"' || ch == '\\' || ch == '/') { if (!buffer_push(&b, (char)ch)) break; }
        else if (ch == 'b') { if (!buffer_push(&b, '\b')) break; }
        else if (ch == 'f') { if (!buffer_push(&b, '\f')) break; }
        else if (ch == 'n') { if (!buffer_push(&b, '\n')) break; }
        else if (ch == 'r') { if (!buffer_push(&b, '\r')) break; }
        else if (ch == 't') { if (!buffer_push(&b, '\t')) break; }
        else if (ch == 'u') {
            unsigned code, low;
            if(!parse_hex_quad(p,&code)) { free(b.data); return NULL; }
            if(code>=0xd800 && code<=0xdbff) {
                if(p->end-p->cursor<6 || p->cursor[0]!='\\' || p->cursor[1]!='u') { fail(p); break; }
                p->cursor+=2;
                if(!parse_hex_quad(p,&low) || low<0xdc00 || low>0xdfff) { fail(p); break; }
                code=0x10000u+((code-0xd800u)<<10)+(low-0xdc00u);
            } else if(code==0 || (code>=0xdc00 && code<=0xdfff)) { fail(p); break; }
            if (!push_utf8(&b, code)) break;
        } else { fail(p); break; }
    }
    free(b.data); if (!p->error) fail(p); return NULL;
}

static owc_json *parse_value(parser *p, int depth);

static int add_child(owc_json *parent, owc_json *child) {
    size_t n = parent->value.children.count;
    owc_json **items = (owc_json **)realloc(parent->value.children.items, (n + 1) * sizeof(*items));
    if (!items) return 0;
    parent->value.children.items = items; items[n] = child; parent->value.children.count = n + 1; return 1;
}

static owc_json *parse_collection(parser *p, int depth, int object) {
    owc_json *value = (owc_json *)calloc(1, sizeof(*value));
    char close = object ? '}' : ']';
    if (!value) return NULL;
    value->type = object ? OWC_JSON_OBJECT : OWC_JSON_ARRAY; p->cursor++; skip_ws(p);
    if (p->cursor < p->end && *p->cursor == close) { p->cursor++; return value; }
    while (p->cursor < p->end) {
        char *key = NULL; owc_json *child;
        if (object) {
            key = parse_string(p); if (!key) break; skip_ws(p);
            if (p->cursor >= p->end || *p->cursor++ != ':') { free(key); fail(p); break; }
        }
        child = parse_value(p, depth + 1); if (!child) { free(key); break; }
        child->key = key;
        if (!add_child(value, child)) { owc_json_free(child); break; }
        skip_ws(p);
        if (p->cursor < p->end && *p->cursor == close) { p->cursor++; return value; }
        if (p->cursor >= p->end || *p->cursor++ != ',') { fail(p); break; }
        skip_ws(p);
    }
    owc_json_free(value); return NULL;
}

static owc_json *scalar(owc_json_type type) { owc_json *v = (owc_json *)calloc(1, sizeof(*v)); if (v) v->type = type; return v; }
static int match(parser *p, const char *word) { size_t n = strlen(word); if ((size_t)(p->end-p->cursor) >= n && memcmp(p->cursor, word, n)==0) { p->cursor += n; return 1; } return 0; }

static int parse_number_token(parser *p, const char **start, const char **end) {
    const char *cursor=p->cursor;
    *start=cursor;
    if(cursor<p->end && *cursor=='-') cursor++;
    if(cursor>=p->end) return 0;
    if(*cursor=='0') cursor++;
    else {
        if(*cursor<'1' || *cursor>'9') return 0;
        while(cursor<p->end && *cursor>='0' && *cursor<='9') cursor++;
    }
    if(cursor<p->end && *cursor=='.') {
        cursor++;
        if(cursor>=p->end || *cursor<'0' || *cursor>'9') return 0;
        while(cursor<p->end && *cursor>='0' && *cursor<='9') cursor++;
    }
    if(cursor<p->end && (*cursor=='e' || *cursor=='E')) {
        cursor++;
        if(cursor<p->end && (*cursor=='+' || *cursor=='-')) cursor++;
        if(cursor>=p->end || *cursor<'0' || *cursor>'9') return 0;
        while(cursor<p->end && *cursor>='0' && *cursor<='9') cursor++;
    }
    *end=cursor; return 1;
}

static owc_json *parse_value(parser *p, int depth) {
    owc_json *value; const char *number_start,*number_end; char *conversion_end;
    skip_ws(p); if (depth > OWC_JSON_MAX_DEPTH || p->cursor >= p->end) { fail(p); return NULL; }
    if (*p->cursor == '{') return parse_collection(p, depth, 1);
    if (*p->cursor == '[') return parse_collection(p, depth, 0);
    if (*p->cursor == '"') { value = scalar(OWC_JSON_STRING); if (!value) return NULL; value->value.string = parse_string(p); if (!value->value.string) { free(value); return NULL; } return value; }
    if (match(p, "true")) { value = scalar(OWC_JSON_BOOL); if (value) value->value.boolean = 1; return value; }
    if (match(p, "false")) return scalar(OWC_JSON_BOOL);
    if (match(p, "null")) return scalar(OWC_JSON_NULL);
    if(!parse_number_token(p,&number_start,&number_end)) { fail(p); return NULL; }
    value = scalar(OWC_JSON_NUMBER); if (!value) return NULL;
    value->value.number = strtod(number_start, &conversion_end);
    if (conversion_end != number_end || !isfinite(value->value.number)) { free(value); fail(p); return NULL; }
    p->cursor = number_end; return value;
}

owc_json *owc_json_parse(const char *text, size_t length, const char **error_at) {
    parser p = {text, text + length, NULL}; owc_json *value = parse_value(&p, 0); skip_ws(&p);
    if (value && p.cursor != p.end) { owc_json_free(value); value = NULL; fail(&p); }
    if (error_at) *error_at = p.error;
    return value;
}

void owc_json_free(owc_json *value) {
    size_t i; if (!value) return; free(value->key);
    if (value->type == OWC_JSON_STRING) free(value->value.string);
    if (value->type == OWC_JSON_ARRAY || value->type == OWC_JSON_OBJECT) { for (i=0;i<value->value.children.count;i++) owc_json_free(value->value.children.items[i]); free(value->value.children.items); }
    free(value);
}

const owc_json *owc_json_object_get(const owc_json *object, const char *key) {
    size_t i; if (!object || object->type != OWC_JSON_OBJECT) return NULL;
    for (i=0;i<object->value.children.count;i++) {
        if (object->value.children.items[i]->key && strcmp(object->value.children.items[i]->key,key)==0)
            return object->value.children.items[i];
    }
    return NULL;
}
const char *owc_json_get_string(const owc_json *value) { return value && value->type == OWC_JSON_STRING ? value->value.string : NULL; }
int owc_json_get_int(const owc_json *value, int fallback) { return value && value->type == OWC_JSON_NUMBER ? (int)value->value.number : fallback; }
int owc_json_get_bool(const owc_json *value, int fallback) { return value && value->type == OWC_JSON_BOOL ? value->value.boolean : fallback; }

char *owc_json_escape_string(const char *value) {
    buffer b = {0}; const unsigned char *p = (const unsigned char *)value; char escaped[7];
    if (!buffer_push(&b, '"')) return NULL;
    while (*p) {
        if (*p == '"' || *p == '\\') { if (!buffer_push(&b,'\\') || !buffer_push(&b,(char)*p)) goto oom; }
        else if (*p == '\b') { if (!buffer_push(&b,'\\') || !buffer_push(&b,'b')) goto oom; }
        else if (*p == '\f') { if (!buffer_push(&b,'\\') || !buffer_push(&b,'f')) goto oom; }
        else if (*p == '\n') { if (!buffer_push(&b,'\\') || !buffer_push(&b,'n')) goto oom; }
        else if (*p == '\r') { if (!buffer_push(&b,'\\') || !buffer_push(&b,'r')) goto oom; }
        else if (*p == '\t') { if (!buffer_push(&b,'\\') || !buffer_push(&b,'t')) goto oom; }
        else if (*p < 0x20) { int i; (void)snprintf(escaped,sizeof(escaped),"\\u%04x",*p); for(i=0;i<6;i++) if(!buffer_push(&b,escaped[i])) goto oom; }
        else if (!buffer_push(&b,(char)*p)) goto oom;
        p++;
    }
    if (!buffer_push(&b,'"')) goto oom;
    return b.data;
oom: free(b.data); return NULL;
}
