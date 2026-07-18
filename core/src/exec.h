#ifndef OWC_EXEC_H
#define OWC_EXEC_H

#include <stddef.h>

typedef void (*owc_exec_output_fn)(void *user_data, const char *stream,
                                   const unsigned char *data, size_t length,
                                   unsigned sequence);

/* Job Object resource limit defaults (Windows; applied whenever the sandbox is
   enabled, for both the AppContainer and the Job Object compatibility modes). */
#define OWC_JOB_DEFAULT_MEMORY_MB 4096ul
#define OWC_JOB_DEFAULT_MAX_PROCESSES 64ul

typedef struct {
    const char *command;
    const char *cwd;
    const char *session_id;
    int sandbox_enabled;
    int allow_network;
    int sandbox_mode; /* owc_sandbox_mode; only meaningful when sandbox_enabled */
    unsigned long job_memory_mb;     /* job-wide committed memory limit; 0 = default */
    unsigned long job_max_processes; /* active process limit; 0 = default */
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
    int sandbox_status;
    char sandbox_reason[192];
} owc_exec_result;

int owc_exec_run(const owc_exec_request *request, owc_exec_result *result);

#endif
