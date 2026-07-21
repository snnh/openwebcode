#ifndef OWC_FS_H
#define OWC_FS_H

#include <stddef.h>

#define OWC_FS_DEFAULT_READ_LINES 2000u
#define OWC_FS_MAX_FILE_SIZE (16u * 1024u * 1024u)
/* Binary RPC uploads are deliberately a little larger than text-file tools:
 * the web PDF ingress permits a single 20 MiB document. */
#define OWC_FS_MAX_BINARY_FILE_SIZE (20u * 1024u * 1024u)
#define OWC_FS_MAX_LIST_ENTRIES 256u

typedef enum {
    OWC_FS_OK = 0,
    OWC_FS_INVALID_ARGUMENT,
    OWC_FS_NOT_FOUND,
    OWC_FS_PERMISSION_DENIED,
    OWC_FS_OUTSIDE_ROOT,
    OWC_FS_IO_ERROR,
    OWC_FS_INVALID_UTF8,
    OWC_FS_NO_MATCH,
    OWC_FS_MULTIPLE_MATCHES,
    OWC_FS_NO_MEMORY
} owc_fs_error;

typedef enum { OWC_FS_TYPE_FILE, OWC_FS_TYPE_DIRECTORY, OWC_FS_TYPE_OTHER } owc_fs_type;

typedef struct { char *content; size_t total_lines; int truncated; } owc_fs_read_result;
typedef struct { owc_fs_type type; unsigned long long size; long long modified_ms; } owc_fs_stat_result;
typedef struct { char *name; owc_fs_type type; unsigned long long size; } owc_fs_entry;
typedef struct { owc_fs_entry *entries; size_t count; int truncated; } owc_fs_list_result;
typedef struct { char **paths; size_t count; int truncated; } owc_fs_glob_result;
typedef struct { char *path; size_t line; char *text; } owc_fs_grep_match;
typedef struct { owc_fs_grep_match *matches; size_t count; int truncated; } owc_fs_grep_result;

int owc_fs_utf8_valid(const char *text, size_t length);
owc_fs_error owc_fs_read(const char *root, const char *path, size_t offset, size_t limit, owc_fs_read_result *result);
owc_fs_error owc_fs_write(const char *root, const char *path, const char *content, size_t length, int create_dirs);
/* Writes validated binary data through the same root-bound, no-reparse
 * platform implementation as fs.write. This is intentionally separate from
 * text writes so agent-facing fs.write remains UTF-8 only. */
owc_fs_error owc_fs_write_binary(const char *root, const char *path, const unsigned char *content, size_t length, int create_dirs);
owc_fs_error owc_fs_edit(const char *root, const char *path, const char *old_text, size_t old_length, const char *new_text, size_t new_length, int replace_all, size_t *matches);
owc_fs_error owc_fs_stat(const char *root, const char *path, owc_fs_stat_result *result);
owc_fs_error owc_fs_list(const char *root, const char *path, owc_fs_list_result *result);
owc_fs_error owc_fs_glob(const char *root, const char *path, const char *pattern, owc_fs_glob_result *result);
owc_fs_error owc_fs_grep(const char *root, const char *path, const char *pattern, owc_fs_grep_result *result);
void owc_fs_read_free(owc_fs_read_result *result);
void owc_fs_list_free(owc_fs_list_result *result);
void owc_fs_glob_free(owc_fs_glob_result *result);
void owc_fs_grep_free(owc_fs_grep_result *result);
const char *owc_fs_error_message(owc_fs_error error);

#endif
