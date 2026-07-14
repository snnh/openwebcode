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
    if (clock_gettime(CLOCK_MONOTONIC, &value) != 0) return 0;
    return (long long)value.tv_sec * 1000 + value.tv_nsec / 1000000;
}

static int make_pipe(int descriptors[2]) {
    return pipe(descriptors) == 0;
}

int owc_platform_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    int out_pipe[2], err_pipe[2], status = 0, running = 1;
    pid_t child;
    long long started = now_ms();
    size_t forwarded = 0;
    unsigned sequence = 0;

    if (!make_pipe(out_pipe)) {
        result->system_error = (unsigned long)errno;
        return 0;
    }
    if (!make_pipe(err_pipe)) {
        result->system_error = (unsigned long)errno;
        close(out_pipe[0]); close(out_pipe[1]);
        return 0;
    }
    child = fork();
    if (child < 0) {
        result->system_error = (unsigned long)errno;
        close(out_pipe[0]); close(out_pipe[1]); close(err_pipe[0]); close(err_pipe[1]);
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
    close(out_pipe[1]); close(err_pipe[1]);
    (void)fcntl(out_pipe[0], F_SETFL, fcntl(out_pipe[0], F_GETFL) | O_NONBLOCK);
    (void)fcntl(err_pipe[0], F_SETFL, fcntl(err_pipe[0], F_GETFL) | O_NONBLOCK);

    while (running || out_pipe[0] >= 0 || err_pipe[0] >= 0) {
        struct pollfd fds[2]; int count = 0, i;
        if (out_pipe[0] >= 0) { fds[count].fd=out_pipe[0]; fds[count].events=POLLIN|POLLHUP; count++; }
        if (err_pipe[0] >= 0) { fds[count].fd=err_pipe[0]; fds[count].events=POLLIN|POLLHUP; count++; }
        if (poll(fds, (nfds_t)count, 20) < 0 && errno != EINTR) break;
        for (i=0;i<count;i++) if (fds[i].revents & (POLLIN|POLLHUP)) {
            unsigned char data[4096]; ssize_t n = read(fds[i].fd, data, sizeof(data));
            if (n > 0) {
                size_t emit = (size_t)n;
                if (forwarded >= request->output_limit) emit = 0;
                else if (emit > request->output_limit-forwarded) emit=request->output_limit-forwarded;
                if (emit && request->on_output) request->on_output(request->user_data, fds[i].fd==out_pipe[0]?"stdout":"stderr", data, emit, sequence++);
                forwarded += emit; if (emit < (size_t)n) result->truncated=1;
            } else if (n == 0) {
                if (fds[i].fd == out_pipe[0]) out_pipe[0]=-1; else err_pipe[0]=-1;
                close(fds[i].fd);
            }
        }
        if (running && waitpid(child, &status, WNOHANG) == child) running=0;
        if (running && now_ms()-started >= request->timeout_ms) {
            (void)kill(-child, SIGKILL); result->timed_out=1;
            while (waitpid(child, &status, 0)<0 && errno==EINTR) {}
            running=0;
        }
    }
    result->duration_ms=now_ms()-started;
    if (WIFEXITED(status)) result->exit_code=WEXITSTATUS(status);
    else if (WIFSIGNALED(status)) result->exit_code=128+WTERMSIG(status);
    return 1;
}
