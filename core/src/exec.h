#ifndef OWC_EXEC_H
#define OWC_EXEC_H

#include <stddef.h>

typedef void (*owc_exec_output_fn)(void *user_data, const char *stream,
                                   const unsigned char *data, size_t length,
                                   unsigned sequence);

typedef struct {
    const char *command;
    const char *cwd;
    int timeout_ms;
    size_t output_limit;
    owc_exec_output_fn on_output;
    void *user_data;
} owc_exec_request;

typedef struct {
    int exit_code;
    long long duration_ms;
    int truncated;
    int timed_out;
    unsigned long system_error;
} owc_exec_result;

int owc_exec_run(const owc_exec_request *request, owc_exec_result *result);

#endif
