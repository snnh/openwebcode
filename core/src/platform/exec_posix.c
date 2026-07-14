#include "exec_platform.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdlib.h>
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

int owc_platform_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    int out_pipe[2] = {-1, -1}, err_pipe[2] = {-1, -1};
    int status = 0, running = 1, ok = 0, saved_error = 0;
    pid_t child = -1;
    long long started = now_ms();
    size_t forwarded = 0;
    unsigned sequence = 0;

    if (started < 0) {
        result->system_error = (unsigned long)errno;
        return 0;
    }
    if (!make_pipe(out_pipe)) {
        result->system_error = (unsigned long)errno;
        return 0;
    }
    if (!make_pipe(err_pipe)) {
        result->system_error = (unsigned long)errno;
        close_fd(&out_pipe[0]); close_fd(&out_pipe[1]);
        return 0;
    }
    child = fork();
    if (child < 0) {
        result->system_error = (unsigned long)errno;
        close_fd(&out_pipe[0]); close_fd(&out_pipe[1]); close_fd(&err_pipe[0]); close_fd(&err_pipe[1]);
        return 0;
    }
    if (child == 0) {
        (void)setpgid(0, 0);
        close(out_pipe[0]); close(err_pipe[0]);
        if (dup2(out_pipe[1], STDOUT_FILENO) < 0 || dup2(err_pipe[1], STDERR_FILENO) < 0) _exit(126);
        close(out_pipe[1]); close(err_pipe[1]);
        if (chdir(request->cwd) != 0) _exit(126);
        execl("/bin/sh", "sh", "-c", request->command, (char *)NULL);
        _exit(127);
    }

    (void)setpgid(child, child);
    close_fd(&out_pipe[1]); close_fd(&err_pipe[1]);
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
        if (current - started >= request->timeout_ms) {
            (void)kill(-child, SIGKILL);
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
    result->duration_ms=now_ms()-started;
    if (WIFEXITED(status)) result->exit_code=WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) result->exit_code=128+WTERMSIG(status);
    ok=1;

cleanup:
    if (!ok && child > 0) {
        (void)kill(-child, SIGKILL);
        if (running) reap_child(child, &status);
        result->system_error=(unsigned long)(saved_error ? saved_error : EIO);
    }
    close_fd(&out_pipe[0]); close_fd(&out_pipe[1]); close_fd(&err_pipe[0]); close_fd(&err_pipe[1]);
    return ok;
}
