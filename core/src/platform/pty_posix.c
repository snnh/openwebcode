#include "../pty.h"
#include "../sandbox.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <pty.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/ioctl.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <termios.h>
#include <unistd.h>

struct owc_pty {
    int master;
    pid_t child;
    pthread_t reader;
    pthread_mutex_t lock; /* guards closing/write/resize */
    int closing;
    int exited;
    int exit_code;
    owc_pty_output_fn on_output;
    owc_pty_exit_fn on_exit;
    void *user_data;
};

/* Live PTY children are session leaders of their own process group (forkpty
 * calls setsid). Track them so the core can kill those groups when it exits,
 * normally or via a fatal signal - same guarantee as exec_posix.c's
 * tracked_children for spawned jobs. */
#define OWC_PTY_MAX_TRACKED 16
static volatile sig_atomic_t tracked_children[OWC_PTY_MAX_TRACKED];
static pthread_mutex_t tracked_children_mutex = PTHREAD_MUTEX_INITIALIZER;

static void track_child(pid_t child) {
    size_t i;
    (void)pthread_mutex_lock(&tracked_children_mutex);
    for (i = 0; i < OWC_PTY_MAX_TRACKED; i++) if (!tracked_children[i]) { tracked_children[i] = child; break; }
    (void)pthread_mutex_unlock(&tracked_children_mutex);
}

static void untrack_child(pid_t child) {
    size_t i;
    (void)pthread_mutex_lock(&tracked_children_mutex);
    for (i = 0; i < OWC_PTY_MAX_TRACKED; i++) if (tracked_children[i] == child) tracked_children[i] = 0;
    (void)pthread_mutex_unlock(&tracked_children_mutex);
}

static void signal_child_group(pid_t child, int sig) {
    if (kill(-child, sig) != 0) (void)kill(child, sig);
}

/* Lock-free on purpose: safe to call from a signal handler (kill is
 * async-signal-safe). A stale slot only costs a harmless ESRCH. */
void owc_pty_terminate_all(void) {
    size_t i;
    for (i = 0; i < OWC_PTY_MAX_TRACKED; i++) {
        pid_t child = (pid_t)tracked_children[i];
        if (child > 0) signal_child_group(child, SIGKILL);
    }
}

int owc_pty_supported(void) {
    return 1; /* openpty/forkpty are baseline POSIX (libutil) */
}

static int write_all(int descriptor, const void *data, size_t size) {
    const unsigned char *cursor = (const unsigned char *)data;
    size_t written = 0;
    while (written < size) {
        ssize_t count = write(descriptor, cursor + written, size - written);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        written += (size_t)count;
    }
    return 1;
}

static void *pty_reader(void *value) {
    owc_pty *pty = (owc_pty *)value;
    unsigned char buffer[16384];
    int status = 0, reaped = 0, closing;
    for (;;) {
        struct pollfd descriptor;
        int poll_result;
        descriptor.fd = pty->master;
        descriptor.events = POLLIN;
        descriptor.revents = 0;
        poll_result = poll(&descriptor, 1, 20);
        if (poll_result < 0) {
            if (errno == EINTR) continue;
            break;
        }
        if (poll_result > 0 && (descriptor.revents & (POLLIN | POLLHUP | POLLERR))) {
            ssize_t count = read(pty->master, buffer, sizeof(buffer));
            if (count > 0) {
                if (pty->on_output) pty->on_output(pty->user_data, buffer, (size_t)count);
                continue;
            }
            if (count == 0) break;
            if (errno == EINTR) continue;
            if (errno == EAGAIN || errno == EWOULDBLOCK) continue;
            break; /* EIO: slave side closed */
        }
        {
            pid_t waited = waitpid(pty->child, &status, WNOHANG);
            if (waited == pty->child) {
                reaped = 1;
                /* Drain trailing output after exit before reporting. */
                for (;;) {
                    struct pollfd drain;
                    ssize_t count;
                    drain.fd = pty->master;
                    drain.events = POLLIN;
                    drain.revents = 0;
                    if (poll(&drain, 1, 50) <= 0) break;
                    count = read(pty->master, buffer, sizeof(buffer));
                    if (count <= 0) break;
                    if (pty->on_output) pty->on_output(pty->user_data, buffer, (size_t)count);
                }
                break;
            }
        }
    }
    if (!reaped) {
        /* Master died before the child was observed exiting: kill the tree
         * and reap so no zombie is left behind. */
        signal_child_group(pty->child, SIGKILL);
        while (waitpid(pty->child, &status, 0) < 0 && errno == EINTR) {}
    }
    (void)pthread_mutex_lock(&pty->lock);
    pty->exited = 1;
    if (WIFEXITED(status)) pty->exit_code = WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) pty->exit_code = 128 + WTERMSIG(status);
    else pty->exit_code = 0;
    closing = pty->closing;
    (void)pthread_mutex_unlock(&pty->lock);
    if (!closing && pty->on_exit) pty->on_exit(pty->user_data, pty->exit_code);
    return NULL;
}

int owc_pty_open(const owc_pty_options *options,
                 owc_pty_output_fn on_output, owc_pty_exit_fn on_exit,
                 void *user_data, owc_pty **result,
                 owc_pty_open_result *open_result, unsigned long *system_error) {
    owc_pty *pty = NULL;
    struct winsize size;
    int sandbox_pipe[2] = {-1, -1};
    pid_t child;
    owc_sandbox_result sandbox;
    ssize_t received;
    int ok = 0;

    memset(&size, 0, sizeof(size));
    memset(&sandbox, 0, sizeof(sandbox));
    memset(open_result, 0, sizeof(*open_result));
    *result = NULL;
    if (!options || !options->cwd || !options->session_id || !options->session_id[0]
        || options->cols < 1 || options->cols > (int)OWC_PTY_MAX_COLS
        || options->rows < 1 || options->rows > (int)OWC_PTY_MAX_ROWS) {
        *system_error = (unsigned long)EINVAL;
        return 0;
    }
    pty = (owc_pty *)calloc(1, sizeof(*pty));
    if (!pty) { *system_error = (unsigned long)ENOMEM; return 0; }
    pty->master = -1;
    pty->child = -1;
    (void)pthread_mutex_init(&pty->lock, NULL);
    pty->on_output = on_output;
    pty->on_exit = on_exit;
    pty->user_data = user_data;

    if (pipe(sandbox_pipe) != 0) { *system_error = (unsigned long)errno; goto cleanup; }
    if (fcntl(sandbox_pipe[1], F_SETFD, FD_CLOEXEC) < 0) { *system_error = (unsigned long)errno; goto cleanup; }
    size.ws_col = (unsigned short)options->cols;
    size.ws_row = (unsigned short)options->rows;
    child = forkpty(&pty->master, NULL, NULL, &size);
    if (child < 0) { *system_error = (unsigned long)errno; goto cleanup; }
    if (child == 0) {
        const char *shell = options->shell;
        const char *name;
        (void)close(sandbox_pipe[0]);
        if (chdir(options->cwd) != 0) _exit(126);
        if (options->sandbox)
            (void)owc_landlock_apply(options->cwd, options->allow_paths,
                                     options->allow_path_count, options->allow_network, &sandbox);
        else {
            sandbox.status = OWC_SANDBOX_ADVISORY;
            (void)snprintf(sandbox.reason, sizeof(sandbox.reason), "sandbox disabled by session policy");
        }
        (void)write_all(sandbox_pipe[1], &sandbox, sizeof(sandbox));
        if (!shell || !shell[0]) {
            shell = getenv("SHELL");
            if (!shell || !shell[0]) shell = "/bin/sh";
        }
        name = strrchr(shell, '/');
        name = name ? name + 1 : shell;
        execlp(shell, name, (char *)NULL);
        _exit(127);
    }
    pty->child = child;
    track_child(child);
    (void)close(sandbox_pipe[1]); sandbox_pipe[1] = -1;
    do { received = read(sandbox_pipe[0], &sandbox, sizeof(sandbox)); } while (received < 0 && errno == EINTR);
    if (received == (ssize_t)sizeof(sandbox)) {
        open_result->sandbox_status = (int)sandbox.status;
        (void)snprintf(open_result->sandbox_reason, sizeof(open_result->sandbox_reason), "%s", sandbox.reason);
    } else {
        open_result->sandbox_status = (int)OWC_SANDBOX_ADVISORY;
        (void)snprintf(open_result->sandbox_reason, sizeof(open_result->sandbox_reason),
                       "child did not report sandbox status");
    }
    if (pthread_create(&pty->reader, NULL, pty_reader, pty) != 0) {
        *system_error = (unsigned long)errno;
        goto cleanup;
    }
    *result = pty;
    ok = 1;

cleanup:
    if (!ok && pty) {
        if (pty->child > 0) {
            int status = 0;
            signal_child_group(pty->child, SIGKILL);
            while (waitpid(pty->child, &status, 0) < 0 && errno == EINTR) {}
        }
        if (pty->master >= 0) (void)close(pty->master);
        untrack_child(pty->child);
        (void)pthread_mutex_destroy(&pty->lock);
        free(pty);
    }
    if (sandbox_pipe[0] >= 0) (void)close(sandbox_pipe[0]);
    if (sandbox_pipe[1] >= 0) (void)close(sandbox_pipe[1]);
    return ok;
}

int owc_pty_write(owc_pty *pty, const unsigned char *data, size_t length) {
    int ok;
    if (!pty || (!data && length)) return 0;
    (void)pthread_mutex_lock(&pty->lock);
    if (pty->closing || pty->exited) { (void)pthread_mutex_unlock(&pty->lock); return 0; }
    ok = write_all(pty->master, data, length);
    (void)pthread_mutex_unlock(&pty->lock);
    return ok;
}

int owc_pty_resize(owc_pty *pty, int cols, int rows) {
    struct winsize size;
    int result;
    if (!pty || cols < 1 || cols > (int)OWC_PTY_MAX_COLS || rows < 1 || rows > (int)OWC_PTY_MAX_ROWS) return 0;
    memset(&size, 0, sizeof(size));
    size.ws_col = (unsigned short)cols;
    size.ws_row = (unsigned short)rows;
    (void)pthread_mutex_lock(&pty->lock);
    if (pty->closing || pty->exited) { (void)pthread_mutex_unlock(&pty->lock); return 0; }
    result = ioctl(pty->master, TIOCSWINSZ, &size);
    (void)pthread_mutex_unlock(&pty->lock);
    return result == 0;
}

void owc_pty_close(owc_pty *pty) {
    int exited;
    if (!pty) return;
    (void)pthread_mutex_lock(&pty->lock);
    pty->closing = 1;
    exited = pty->exited;
    (void)pthread_mutex_unlock(&pty->lock);
    if (!exited && pty->child > 0) signal_child_group(pty->child, SIGKILL);
    (void)pthread_join(pty->reader, NULL);
    untrack_child(pty->child);
    if (pty->master >= 0) (void)close(pty->master);
    (void)pthread_mutex_destroy(&pty->lock);
    free(pty);
}
