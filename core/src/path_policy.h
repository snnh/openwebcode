#ifndef OWC_PATH_POLICY_H
#define OWC_PATH_POLICY_H

#include <stddef.h>

typedef enum { OWC_PATH_READ, OWC_PATH_WRITE } owc_path_permission;

typedef struct {
    const char *const *read_roots; size_t read_root_count;
    const char *const *write_roots; size_t write_root_count;
    const char *const *deny_roots; size_t deny_root_count;
} owc_path_policy;

int owc_path_resolve(const char *input, char *output, size_t output_size);
int owc_path_is_within(const char *path, const char *root);
int owc_path_policy_check(const owc_path_policy *policy, const char *path,
                          owc_path_permission permission);

#endif
