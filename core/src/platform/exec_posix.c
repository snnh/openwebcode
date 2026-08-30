#include "exec_platform.h"
#include "bwrap.h"
#include "sandbox.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <pthread.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/resource.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <time.h>
#include <unistd.h>

static long long now_ms(void) {
    struct timespec value;
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return -1;
    return (long long)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static int make_pipe(int descriptors[2]) {
    return pipe(descriptors) == 0;
}

static void close_fd(int *descriptor) {
    if (*descriptor >= 0) {
        (void)close(*descriptor);
        *descriptor = -1;
    }
}

static void reap_child(pid_t child, int *status) {
    while (waitpid(child, status, 0) < 0 && errno == EINTR) {}
}

/* The group is established from both sides (the child setpgids itself first
 * thing after fork, the parent repeats it right after fork returns), so by
 * the time any kill is issued the child already leads its own group and
 * kill(-child) reaches the whole tree, grandchildren included.  The only
 * remaining ESRCH window is a child that already exited; then the group is
 * empty anyway and the direct kill fallback is a harmless no-op. */
static void signal_child_group(pid_t child, int sig) {
    if (kill(-child, sig) != 0) (void)kill(child, sig);
}

/* Live children run in their own process group (setpgid below).  Track them
 * so the core can kill those groups when it exits, normally or via a fatal
 * signal, instead of orphaning the spawned trees. */
#define OWC_EXEC_MAX_TRACKED 16
static volatile sig_atomic_t tracked_children[OWC_EXEC_MAX_TRACKED];
static pthread_mutex_t tracked_children_mutex=PTHREAD_MUTEX_INITIALIZER;
static void track_child(pid_t child) {
    size_t i;
    (void)pthread_mutex_lock(&tracked_children_mutex);
    for(i=0;i<OWC_EXEC_MAX_TRACKED;i++) if(!tracked_children[i]) { tracked_children[i]=child; break; }
    (void)pthread_mutex_unlock(&tracked_children_mutex);
}
static void untrack_child(pid_t child) {
    size_t i;
    (void)pthread_mutex_lock(&tracked_children_mutex);
    for(i=0;i<OWC_EXEC_MAX_TRACKED;i++) if(tracked_children[i]==child) tracked_children[i]=0;
    (void)pthread_mutex_unlock(&tracked_children_mutex);
}
/* Lock-free on purpose: safe to call from a signal handler (kill is
 * async-signal-safe).  A stale slot only costs a harmless ESRCH. */
void owc_platform_exec_terminate_all(void) {
    size_t i;
    for(i=0;i<OWC_EXEC_MAX_TRACKED;i++) {
        pid_t child=(pid_t)tracked_children[i];
        if(child>0) signal_child_group(child,SIGKILL);
    }
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

/* A failed exec is indistinguishable from a command exiting 127 unless the
 * child says so: report the exec errno through a CLOEXEC pipe.  A successful
 * exec closes the write end (the parent reads EOF); a failed one delivers
 * the errno the attempt died with. */
static void report_exec_failure(int descriptor, int error) {
    (void)write_all(descriptor, &error, sizeof(error));
}

int owc_platform_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    int out_pipe[2] = {-1, -1}, err_pipe[2] = {-1, -1}, sandbox_pipe[2] = {-1, -1}, exec_pipe[2] = {-1, -1};
    int status = 0, running = 1, ok = 0, saved_error = 0;
    pid_t child = -1;
    long long started = now_ms();
    size_t forwarded = 0;
    unsigned sequence = 0;
    owc_sandbox_result sandbox;
    memset(&sandbox,0,sizeof(sandbox));

    if (started < 0) {
        result->system_error = (unsigned long)errno;
        return 0;
    }
    if (!make_pipe(out_pipe)) {
        result->system_error = (unsigned long)errno;
        return 0;
    }
    if (!make_pipe(err_pipe) || !make_pipe(sandbox_pipe) || !make_pipe(exec_pipe)) {
        result->system_error = (unsigned long)errno;
        close_fd(&out_pipe[0]); close_fd(&out_pipe[1]); close_fd(&err_pipe[0]); close_fd(&err_pipe[1]); close_fd(&sandbox_pipe[0]); close_fd(&sandbox_pipe[1]); close_fd(&exec_pipe[0]); close_fd(&exec_pipe[1]);
        return 0;
    }
    if(fcntl(out_pipe[0],F_SETFD,FD_CLOEXEC)<0||fcntl(out_pipe[1],F_SETFD,FD_CLOEXEC)<0||fcntl(err_pipe[0],F_SETFD,FD_CLOEXEC)<0||fcntl(err_pipe[1],F_SETFD,FD_CLOEXEC)<0||fcntl(sandbox_pipe[0],F_SETFD,FD_CLOEXEC)<0||fcntl(sandbox_pipe[1],F_SETFD,FD_CLOEXEC)<0||fcntl(exec_pipe[0],F_SETFD,FD_CLOEXEC)<0||fcntl(exec_pipe[1],F_SETFD,FD_CLOEXEC)<0){result->system_error=(unsigned long)errno;close_fd(&out_pipe[0]);close_fd(&out_pipe[1]);close_fd(&err_pipe[0]);close_fd(&err_pipe[1]);close_fd(&sandbox_pipe[0]);close_fd(&sandbox_pipe[1]);close_fd(&exec_pipe[0]);close_fd(&exec_pipe[1]);return 0;}
    child = fork();
    if (child < 0) {
        result->system_error = (unsigned long)errno;
        close_fd(&out_pipe[0]); close_fd(&out_pipe[1]); close_fd(&err_pipe[0]); close_fd(&err_pipe[1]); close_fd(&sandbox_pipe[0]); close_fd(&sandbox_pipe[1]); close_fd(&exec_pipe[0]); close_fd(&exec_pipe[1]);
        return 0;
    }
    if (child == 0) {
        (void)setpgid(0, 0);
        close(out_pipe[0]); close(err_pipe[0]); close(sandbox_pipe[0]); close(exec_pipe[0]);
        if (dup2(out_pipe[1], STDOUT_FILENO) < 0 || dup2(err_pipe[1], STDERR_FILENO) < 0) _exit(126);
        close(out_pipe[1]); close(err_pipe[1]);
        /* stdin must not stay on the RPC pipe: exec.run runs in a job thread
         * while the main loop blocks reading server->core frames, and a
         * command that reads stdin (cat, git) would race it - either leaking
         * cross-session input into the command or consuming a partial frame
         * that kills the loop.  /dev/null is the POSIX counterpart of the
         * Windows NUL stand-in. */
        {int devnull = open("/dev/null", O_RDONLY);
         if (devnull < 0 || dup2(devnull, STDIN_FILENO) < 0) _exit(126);
         if (devnull > STDIN_FILENO) (void)close(devnull);}
        if (chdir(request->cwd) != 0) _exit(126);
        /* POSIX counterpart of the Windows Job Object resource limits, under
         * the same gate (only where the sandbox is the enforcement layer).
         * RLIMIT_AS approximates the committed-memory limit and RLIMIT_NPROC
         * the process limit.  Best effort: a failed setrlimit must not block
         * the exec. */
        if (request->sandbox_enabled) {
            struct rlimit limit;
            if (request->job_memory_mb > 0) {
                limit.rlim_cur = limit.rlim_max =
                    (rlim_t)request->job_memory_mb * 1024u * 1024u;
                (void)setrlimit(RLIMIT_AS, &limit);
            }
            if (request->job_max_processes > 0) {
                limit.rlim_cur = limit.rlim_max =
                    (rlim_t)request->job_max_processes;
                (void)setrlimit(RLIMIT_NPROC, &limit);
            }
        }
        if (request->sandbox_enabled) {
            /* Backend selection: an explicit landlock mode forces Landlock;
             * every other mode (including the Windows appcontainer/jobobject
             * values, which POSIX accepts but ignores) means bubblewrap and
             * nothing else.  There is no automatic Landlock fallback:
             * Landlock's additive rules cannot express denyPaths, so a
             * silent fallback would quietly weaken the session's isolation;
             * landlock mode is the explicit, weaker compatibility tier. */
            if (request->sandbox_mode != (int)OWC_SANDBOX_MODE_LANDLOCK) {
                owc_sandbox_result bwrap;
                owc_bwrap_probe(&bwrap);
                if (bwrap.status == OWC_SANDBOX_ENFORCED) {
                    /* bwrap keeps the child's process group (it does not
                     * setpgid), so the whole tree stays reachable by the
                     * kill(-pgid) process-tree termination above. */
                    char *shell_argv[8];
                    sandbox.status = OWC_SANDBOX_ENFORCED;
                    (void)snprintf(sandbox.reason, sizeof(sandbox.reason),
                                   "bubblewrap namespace isolation");
                    if (!write_all(sandbox_pipe[1], &sandbox, sizeof(sandbox))) _exit(126);
                    if (request->shell_backend == (int)OWC_SHELL_PWSH) {
                        shell_argv[0] = (char *)"pwsh";
                        shell_argv[1] = (char *)"-NoLogo";
                        shell_argv[2] = (char *)"-NoProfile";
                        shell_argv[3] = (char *)"-NonInteractive";
                        shell_argv[4] = (char *)"-Command";
                        shell_argv[5] = (char *)request->command;
                        shell_argv[6] = NULL;
                    } else if (request->shell_backend == (int)OWC_SHELL_BASH) {
                        shell_argv[0] = (char *)((request->shell_path && request->shell_path[0]) ? request->shell_path : "bash");
                        shell_argv[1] = (char *)"-c";
                        shell_argv[2] = (char *)request->command;
                        shell_argv[3] = NULL;
                    } else {
                        shell_argv[0] = (char *)"/bin/sh";
                        shell_argv[1] = (char *)"-c";
                        shell_argv[2] = (char *)request->command;
                        shell_argv[3] = NULL;
                    }
                    {
                        /* Only returns when the bwrap exec itself failed
                         * (e.g. the binary raced away after the probe). */
                        int bwrap_error = owc_bwrap_exec(request->cwd,
                            request->read_roots, request->read_root_count,
                            request->read_only_paths, request->read_only_count,
                            request->write_roots, request->write_root_count,
                            request->deny_paths, request->deny_path_count,
                            request->allow_paths, request->allow_path_count,
                            request->allow_network, shell_argv);
                        report_exec_failure(exec_pipe[1], bwrap_error);
                        (void)dprintf(STDERR_FILENO, "failed to exec bwrap: %s\n", strerror(bwrap_error));
                    }
                    _exit(127);
                }
                /* Fail-closed: report the reason through the sandbox pipe,
                 * then refuse to run the command bare (no Landlock fallback:
                 * it cannot express denyPaths, so it would silently weaken
                 * the session's isolation). */
                sandbox.status = OWC_SANDBOX_ADVISORY;
                (void)snprintf(sandbox.reason, sizeof(sandbox.reason),
                               "bubblewrap unavailable: %.68s; install bubblewrap or select sandbox mode landlock (weaker: denyPaths not enforced for commands)",
                               bwrap.reason);
            } else {
                (void)owc_landlock_apply(request->cwd, request->allow_paths, request->allow_path_count,
                                         request->read_roots, request->read_root_count,
                                         request->read_only_paths, request->read_only_count,
                                         request->write_roots, request->write_root_count,
                                         request->allow_network, &sandbox);
                /* ADVISORY here means the explicit Landlock ruleset could
                 * not be applied; the common fail-closed gate below refuses
                 * to run the command bare. */
            }
        } else {
            sandbox.status = OWC_SANDBOX_ADVISORY;
            (void)snprintf(sandbox.reason, sizeof(sandbox.reason), "sandbox disabled by session policy");
        }
        if(!write_all(sandbox_pipe[1],&sandbox,sizeof(sandbox)))_exit(126);
        /* Fail-closed gate: an enabled session whose sandbox ended up
         * ADVISORY (bwrap unavailable in the default tier, or an explicit
         * Landlock apply failure) must not run the command bare. */
        if (request->sandbox_enabled && sandbox.status == OWC_SANDBOX_ADVISORY) _exit(126);
        if(request->shell_backend==(int)OWC_SHELL_PWSH) {
            execlp("pwsh", "pwsh", "-NoLogo", "-NoProfile", "-NonInteractive", "-Command", request->command, (char *)NULL);
            report_exec_failure(exec_pipe[1], errno);
            (void)dprintf(STDERR_FILENO,"pwsh executable was not found\n");
        } else if(request->shell_backend==(int)OWC_SHELL_BASH) {
            const char *shell=(request->shell_path&&request->shell_path[0])?request->shell_path:"bash";
            execlp(shell, "bash", "-c", request->command, (char *)NULL);
            report_exec_failure(exec_pipe[1], errno);
            (void)dprintf(STDERR_FILENO,"bash executable was not found\n");
        } else {
            execl("/bin/sh", "sh", "-c", request->command, (char *)NULL);
            report_exec_failure(exec_pipe[1], errno);
        }
        _exit(127);
    }

    track_child(child);
    (void)setpgid(child, child);
    close_fd(&out_pipe[1]); close_fd(&err_pipe[1]); close_fd(&sandbox_pipe[1]); close_fd(&exec_pipe[1]);
    if (fcntl(out_pipe[0], F_SETFL, fcntl(out_pipe[0], F_GETFL) | O_NONBLOCK) < 0 ||
        fcntl(err_pipe[0], F_SETFL, fcntl(err_pipe[0], F_GETFL) | O_NONBLOCK) < 0) {
        saved_error = errno;
        goto cleanup;
    }

    while (running || out_pipe[0] >= 0 || err_pipe[0] >= 0) {
        struct pollfd fds[2];
        int count = 0, i, poll_result;
        long long current = now_ms();
        if (current < 0) { saved_error = errno; goto cleanup; }
        if (request->cancel_requested && *request->cancel_requested) {
            int attempts;
            signal_child_group(child, SIGTERM);
            for(attempts=0;running&&attempts<10;attempts++) {
                pid_t waited=waitpid(child,&status,WNOHANG);
                if(waited==child) { running=0; break; }
                if(waited<0&&errno!=EINTR) { saved_error=errno; goto cleanup; }
                {struct timespec pause={0,50*1000*1000};(void)nanosleep(&pause,NULL);}
            }
            if(running) { signal_child_group(child,SIGKILL); reap_child(child,&status); running=0; }
            result->cancelled = 1;
            close_fd(&out_pipe[0]); close_fd(&err_pipe[0]);
            break;
        }
        if (current - started >= request->timeout_ms) {
            signal_child_group(child, SIGKILL);
            result->timed_out = 1;
            if (running) reap_child(child, &status);
            running = 0;
            close_fd(&out_pipe[0]); close_fd(&err_pipe[0]);
            break;
        }
        if (out_pipe[0] >= 0) { fds[count].fd=out_pipe[0]; fds[count].events=POLLIN|POLLHUP; fds[count].revents=0; count++; }
        if (err_pipe[0] >= 0) { fds[count].fd=err_pipe[0]; fds[count].events=POLLIN|POLLHUP; fds[count].revents=0; count++; }
        poll_result = poll(fds, (nfds_t)count, 20);
        if (poll_result < 0) {
            if (errno == EINTR) continue;
            saved_error = errno;
            goto cleanup;
        }
        for (i=0;i<count;i++) {
            if (fds[i].revents & (POLLERR|POLLNVAL)) { saved_error = EIO; goto cleanup; }
            if (fds[i].revents & (POLLIN|POLLHUP)) {
                unsigned char data[4096];
                ssize_t n = read(fds[i].fd, data, sizeof(data));
                if (n > 0) {
                    size_t emit = (size_t)n;
                    if (forwarded >= request->output_limit) emit = 0;
                    else if (emit > request->output_limit-forwarded) emit=request->output_limit-forwarded;
                    if (emit && request->on_output) request->on_output(request->user_data, fds[i].fd==out_pipe[0]?"stdout":"stderr", data, emit, sequence++);
                    forwarded += emit; if (emit < (size_t)n) result->truncated=1;
                } else if (n == 0) {
                    if (fds[i].fd == out_pipe[0]) close_fd(&out_pipe[0]); else close_fd(&err_pipe[0]);
                } else if (errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR) {
                    saved_error = errno;
                    goto cleanup;
                }
            }
        }
        if (running) {
            pid_t waited = waitpid(child, &status, WNOHANG);
            if (waited == child) running=0;
            else if (waited < 0 && errno != EINTR) { saved_error=errno; goto cleanup; }
        }
    }
    {ssize_t received;do{received=read(sandbox_pipe[0],&sandbox,sizeof(sandbox));}while(received<0&&errno==EINTR);if(received==(ssize_t)sizeof(sandbox)){result->sandbox_status=(int)sandbox.status;(void)snprintf(result->sandbox_reason,sizeof(result->sandbox_reason),"%s",sandbox.reason);}else{result->sandbox_status=(int)OWC_SANDBOX_ADVISORY;(void)snprintf(result->sandbox_reason,sizeof(result->sandbox_reason),"child did not report sandbox status");}}
    {
        int exec_error=0;ssize_t received;
        do{received=read(exec_pipe[0],&exec_error,sizeof(exec_error));}while(received<0&&errno==EINTR);
        if(received==(ssize_t)sizeof(exec_error)&&exec_error==ENOENT&&request->shell_backend!=(int)OWC_SHELL_DEFAULT){
            /* Windows shell_unavailable parity: an explicitly selected
             * pwsh/bash interpreter that does not exist is reported to the
             * RPC layer instead of surfacing as a plain exit 127. */
            result->shell_unavailable=1;
            result->duration_ms=now_ms()-started;
            saved_error=exec_error;
            goto cleanup;
        }
    }
    result->duration_ms=now_ms()-started;
    if (WIFEXITED(status)) result->exit_code=WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) result->exit_code=128+WTERMSIG(status);
    ok=1;

cleanup:
    if (!ok && child > 0) {
        signal_child_group(child, SIGKILL);
        if (running) reap_child(child, &status);
        result->system_error=(unsigned long)(saved_error ? saved_error : EIO);
    }
    close_fd(&out_pipe[0]); close_fd(&out_pipe[1]); close_fd(&err_pipe[0]); close_fd(&err_pipe[1]); close_fd(&sandbox_pipe[0]); close_fd(&sandbox_pipe[1]); close_fd(&exec_pipe[0]); close_fd(&exec_pipe[1]);
    untrack_child(child);
    return ok;
}
