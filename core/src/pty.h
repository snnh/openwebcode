#ifndef OWC_PTY_H
#define OWC_PTY_H

#include <stddef.h>

/* PTY limits published by core.ping. */
#define OWC_PTY_MAX_CONCURRENT 16u
#define OWC_PTY_MAX_OUTPUT_CHUNK_BYTES (64u * 1024u)
#define OWC_PTY_MAX_INPUT_BYTES (8u * 1024u)
#define OWC_PTY_MAX_COLS 512u
#define OWC_PTY_MAX_ROWS 512u

typedef struct owc_pty owc_pty;

/* Both callbacks run on the PTY reader thread and must not call back into
 * the PTY handle. on_exit runs exactly once when the child process exits. */
typedef void (*owc_pty_output_fn)(void *user_data, const unsigned char *data, size_t length);
typedef void (*owc_pty_exit_fn)(void *user_data, int exit_code);

typedef struct {
    const char *shell;      /* NULL: platform default (cmd.exe / $SHELL or /bin/sh) */
    const char *cwd;
    const char *session_id; /* sandbox identity; required even when sandbox=0 */
    int cols;
    int rows;
    int sandbox;            /* 1: apply session sandbox policy; 0: owner identity */
    int allow_network;
    int sandbox_mode;       /* owc_sandbox_mode; only meaningful when sandbox=1 */
    /* Additional configured sandbox write roots (same semantics as exec). */
    const char *const *allow_paths;
    size_t allow_path_count;
    unsigned long job_memory_mb;     /* Windows Job Object fallback limits; 0 = default */
    unsigned long job_max_processes; /* 0 = default */
} owc_pty_options;

typedef struct {
    int sandbox_status;     /* owc_sandbox_status */
    char sandbox_reason[192];
} owc_pty_open_result;

/* Runtime capability: ConPTY (Windows 10 1809+) or openpty/forkpty (POSIX).
 * core.ping advertises the pty feature only when this is nonzero. */
int owc_pty_supported(void);

/* Starts the shell attached to a new pseudo-terminal plus a reader thread
 * that streams output and the final exit through the callbacks.
 * Returns 1 on success; on failure returns 0 and sets *system_error. */
int owc_pty_open(const owc_pty_options *options,
                 owc_pty_output_fn on_output, owc_pty_exit_fn on_exit,
                 void *user_data, owc_pty **result,
                 owc_pty_open_result *open_result, unsigned long *system_error);

int owc_pty_write(owc_pty *pty, const unsigned char *data, size_t length);
int owc_pty_resize(owc_pty *pty, int cols, int rows);

/* Terminates the process tree (Job Object / process-group kill), joins the
 * reader thread and frees the handle. Safe on an already-exited PTY. */
void owc_pty_close(owc_pty *pty);

/* Kills every live PTY process group on the POSIX core-exit path. On Windows
 * the Job Object KILL_ON_JOB_CLOSE already covers core exit, so this is a
 * no-op there. */
void owc_pty_terminate_all(void);

#endif
