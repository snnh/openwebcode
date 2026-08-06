#ifndef OWC_EXEC_H
#define OWC_EXEC_H

#include <stddef.h>

typedef void (*owc_exec_output_fn)(void *user_data, const char *stream,
                                   const unsigned char *data, size_t length,
                                   unsigned sequence);

/* Job Object resource limit defaults.  Windows: applied only when the sandbox
   is enabled and no AppContainer profile is active - explicit jobobject mode,
   AppContainer creation fallback, or advisory - i.e. where the Job Object is
   the only enforcement.  POSIX: applied via setrlimit in the child before
   exec, likewise only when the sandbox is enabled; RLIMIT_AS approximates the
   committed-memory limit and RLIMIT_NPROC the process limit.  Both are best
   effort on POSIX: a failed setrlimit does not block the exec, and
   RLIMIT_NPROC counts processes per real uid rather than per process tree,
   so it is only a coarse ceiling. */
#define OWC_JOB_DEFAULT_MEMORY_MB 4096ul
#define OWC_JOB_DEFAULT_MAX_PROCESSES 64ul

typedef enum {
    OWC_SHELL_DEFAULT = 0,
    OWC_SHELL_PWSH = 1,
    OWC_SHELL_BASH = 2
} owc_shell_backend;

typedef struct {
    const char *command;
    const char *cwd;
    const char *session_id;
    int sandbox_enabled;
    int allow_network;
    int sandbox_mode; /* owc_sandbox_mode; only meaningful when sandbox_enabled */
    int shell_backend; /* owc_shell_backend */
    /* Optional explicit shell executable path from the host detection layer
       (e.g. an absolute bash.exe path for Git Bash, which must not be
       resolved to the WSL launcher in System32).  Takes precedence over the
       per-backend executable search; the argument style still follows
       shell_backend. */
    const char *shell_path;
    /* Additional configured AppContainer write roots. The platform layer adds
       cwd, normalizes the combined list, and removes duplicates. */
    const char *const *allow_paths;
    size_t allow_path_count;
    /* Session read/write/deny roots (POSIX sandbox policy; borrowed pointers
       valid for the call).  The POSIX backends apply them to the child
       process: bubblewrap binds/masks them in the mount namespace, Landlock
       grants write_roots read/write and read_roots read-only (deny_paths
       cannot be expressed in additive Landlock rules and remains enforced at
       the fs.* RPC layer).  Windows ignores these; its root policy stays in
       the fs.* primitives. */
    const char *const *read_roots;
    size_t read_root_count;
    const char *const *write_roots;
    size_t write_root_count;
    const char *const *deny_paths;
    size_t deny_path_count;
    /* Session Bind Link backing directories (Windows): granted to the
       AppContainer so sandboxed processes can reach the bound tree through
       its virtPath.  Borrowed pointers valid for the call; NULL/0 when the
       session has no bindLinks. */
    const char *const *bind_backing;
    const int *bind_read_only;
    size_t bind_count;
    /* Filtered-network session state (Windows AppContainer): business
       executions run with no network capability SIDs and get the proxy
       environment injected; a per-exec network override (allow) instead
       grants internetClient+privateNetworkClientServer for the in-sandbox
       proxy sidecar.  proxy_addr is the session "host:port" proxy address
       (NULL: no injection).  POSIX ignores both (filtered is rejected at
       configure time there). */
    int network_filtered;
    const char *proxy_addr;
    /* Session read-only grants (sandbox.readOnlyPaths; borrowed pointers
       valid for the call): bwrap ro-binds them, Landlock grants read+execute,
       Windows grants the AppContainer a read/traverse/execute ACL tier. */
    const char *const *read_only_paths;
    size_t read_only_count;
    unsigned long job_memory_mb;     /* job-wide committed memory limit; 0 = default */
    unsigned long job_max_processes; /* active process limit; 0 = default */
    int timeout_ms;
    size_t output_limit;
    /* Optional cooperative cancellation flag.  The platform executor owns the
       process tree and observes this while draining output; a future job
       controller can therefore terminate only this execution. */
    const volatile int *cancel_requested;
    owc_exec_output_fn on_output;
    void *user_data;
} owc_exec_request;

typedef struct {
    int exit_code;
    long long duration_ms;
    int truncated;
    int timed_out;
    int cancelled;
    unsigned long system_error;
    int shell_unavailable;
    int sandbox_status;
    char sandbox_reason[192];
} owc_exec_result;

int owc_exec_run(const owc_exec_request *request, owc_exec_result *result);

#endif
