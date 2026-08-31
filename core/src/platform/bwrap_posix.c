#include "../bwrap.h"

#include <errno.h>
#include <stdio.h>

#ifdef __linux__

#include <fcntl.h>
#include <pthread.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>
#include <unistd.h>

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

/* System trees every sandboxed command may read/execute: the bwrap
 * counterpart of the Landlock read-exec exemption table in sandbox_posix.c.
 * /proc, /dev and /tmp are provided by dedicated bwrap flags instead of
 * binds. */
static const char *const bwrap_read_exec_paths[] = {
    "/usr", "/bin", "/lib", "/lib64", "/etc", "/sys"
};
#define BWRAP_READ_EXEC_PATH_COUNT \
    (sizeof(bwrap_read_exec_paths) / sizeof(bwrap_read_exec_paths[0]))

static int path_has_executable(const char *name) {
    const char *path = getenv("PATH");
    const char *cursor;
    char candidate[PATH_MAX];
    if (!path || !path[0]) path = "/usr/local/bin:/usr/bin:/bin";
    cursor = path;
    for (;;) {
        const char *colon = strchr(cursor, ':');
        size_t dir_length = colon ? (size_t)(colon - cursor) : strlen(cursor);
        size_t name_length = strlen(name);
        if (dir_length && dir_length + 1u + name_length < sizeof(candidate)) {
            memcpy(candidate, cursor, dir_length);
            candidate[dir_length] = '/';
            memcpy(candidate + dir_length + 1, name, name_length + 1);
            if (access(candidate, X_OK) == 0) return 1;
        }
        if (!colon) break;
        cursor = colon + 1;
    }
    return 0;
}

static void set_probe_result(owc_sandbox_result *result, owc_sandbox_status status,
                             int error_number, const char *reason) {
    result->status = status;
    result->abi = 0;
    result->error_number = error_number;
    (void)snprintf(result->reason, sizeof(result->reason), "%s", reason);
}

static owc_sandbox_result probe_cache;
static pthread_once_t probe_once = PTHREAD_ONCE_INIT;

/* The smoke run proves the whole unprivileged path bwrap needs (user
 * namespace creation, a bind mount, exec) instead of trusting a version
 * query: kernels with unprivileged userns disabled and Ubuntu 24.04's
 * AppArmor restriction both fail here with a useful stderr message.  It
 * also passes --unshare-net, the network-deny switch, so a kernel that
 * forbids unprivileged network namespaces is caught too: filesystem-only
 * sandboxes would still work, so that failure is reported as partial
 * rather than unavailable (see probe_run's failure classification). */
static void probe_run(void) {
    int pipefd[2];
    pid_t pid;
    int status = 0;
    char captured[160];
    size_t captured_length = 0;
    captured[0] = '\0';
    if (!path_has_executable("bwrap")) {
        set_probe_result(&probe_cache, OWC_SANDBOX_ADVISORY, ENOENT,
                         "bubblewrap (bwrap) executable not found on PATH");
        return;
    }
    if (pipe(pipefd) != 0) {
        set_probe_result(&probe_cache, OWC_SANDBOX_ADVISORY, errno,
                         "bubblewrap probe pipe failed");
        return;
    }
    pid = fork();
    if (pid < 0) {
        int saved = errno;
        (void)close(pipefd[0]);
        (void)close(pipefd[1]);
        set_probe_result(&probe_cache, OWC_SANDBOX_ADVISORY, saved,
                         "bubblewrap probe fork failed");
        return;
    }
    if (pid == 0) {
        int devnull;
        (void)close(pipefd[0]);
        (void)dup2(pipefd[1], STDERR_FILENO);
        devnull = open("/dev/null", O_RDWR);
        if (devnull >= 0) {
            (void)dup2(devnull, STDIN_FILENO);
            (void)dup2(devnull, STDOUT_FILENO);
            if (devnull > STDERR_FILENO) (void)close(devnull);
        }
        execlp("bwrap", "bwrap", "--die-with-parent", "--unshare-user",
               "--unshare-net",
               "--ro-bind", "/", "/", "--", "true", (char *)NULL);
        (void)dprintf(STDERR_FILENO, "exec bwrap failed: %s\n", strerror(errno));
        _exit(127);
    }
    (void)close(pipefd[1]);
    while (waitpid(pid, &status, 0) < 0 && errno == EINTR) {}
    /* bwrap runs true and exits; no grandchild keeps the pipe open, so a
     * full drain after waitpid terminates.  Only the tail is kept: early
     * lines are usually bwrap boilerplate, the failure is at the end. */
    for (;;) {
        char chunk[128];
        ssize_t count = read(pipefd[0], chunk, sizeof(chunk));
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) break;
        if (captured_length + (size_t)count < sizeof(captured)) {
            memcpy(captured + captured_length, chunk, (size_t)count);
            captured_length += (size_t)count;
        } else {
            size_t overflow = captured_length + (size_t)count - (sizeof(captured) - 1u);
            if (overflow < captured_length) {
                memmove(captured, captured + overflow, captured_length - overflow);
                captured_length -= overflow;
                memcpy(captured + captured_length, chunk, (size_t)count);
                captured_length += (size_t)count;
            } else {
                size_t keep = (size_t)count < sizeof(captured) - 1u
                    ? (size_t)count : sizeof(captured) - 1u;
                memcpy(captured, chunk + (size_t)count - keep, keep);
                captured_length = keep;
            }
        }
    }
    captured[captured_length] = '\0';
    (void)close(pipefd[0]);
    while (captured_length && (captured[captured_length - 1] == '\n' ||
           captured[captured_length - 1] == '\r')) {
        captured[--captured_length] = '\0';
    }
    if (WIFEXITED(status) && WEXITSTATUS(status) == 0) {
        set_probe_result(&probe_cache, OWC_SANDBOX_ENFORCED, 0,
                         "bubblewrap namespace isolation available");
        return;
    }
    /* With --unshare-net in the smoke, a kernel that forbids unprivileged
     * network namespaces fails the run even though filesystem isolation
     * works.  Report partial so sessions that need network denial do not
     * look enforceable; the captured tail names the netns failure. */
    if (captured_length && strstr(captured, "network namespace")) {
        probe_cache.status = OWC_SANDBOX_PARTIAL;
        probe_cache.abi = 0;
        probe_cache.error_number = WIFEXITED(status) ? WEXITSTATUS(status) : EIO;
        (void)snprintf(probe_cache.reason, sizeof(probe_cache.reason),
                       "bubblewrap network namespace isolation unavailable: %.120s",
                       captured);
        return;
    }
    probe_cache.status = OWC_SANDBOX_ADVISORY;
    probe_cache.abi = 0;
    probe_cache.error_number = WIFEXITED(status) ? WEXITSTATUS(status) : EIO;
    if (captured_length)
        (void)snprintf(probe_cache.reason, sizeof(probe_cache.reason),
                       "bubblewrap smoke run failed: %s", captured);
    else
        (void)snprintf(probe_cache.reason, sizeof(probe_cache.reason),
                       "bubblewrap smoke run failed (exit status %d)",
                       probe_cache.error_number);
}

void owc_bwrap_probe(owc_sandbox_result *result) {
    if (!result) return;
    (void)pthread_once(&probe_once, probe_run);
    *result = probe_cache;
}

char **owc_bwrap_build_argv(const char *cwd,
                            const char *const *read_roots, size_t read_root_count,
                            const char *const *read_only_paths, size_t read_only_count,
                            const char *const *write_roots, size_t write_root_count,
                            const char *const *deny_paths, size_t deny_path_count,
                            const char *const *allow_paths, size_t allow_path_count,
                            int allow_network, char *const *command_argv) {
    /* Worst case with the 32-entry root list caps and 16 deny paths:
     * 8 fixed prologue/epilogue entries plus 3 per read-exec path, 3-4 per
     * bounded root, 4 per deny path, and the command tail.  That far exceeds
     * any fixed stack array, so the argv vector is allocated dynamically
     * (the old fixed 256 entries returned E2BIG when the RPC caps were
     * raised); only allocation failure can stop the build now.  This runs in
     * the parent before fork: malloc is unsafe in the forked child of this
     * multithreaded process. */
    size_t argc = 0, i, command_count = 0, argv_count;
    char **argv;
    while (command_argv[command_count]) command_count++;
    argv_count = 8u + 3u * BWRAP_READ_EXEC_PATH_COUNT +
                 3u * (read_root_count + read_only_count + allow_path_count + write_root_count) +
                 4u * deny_path_count + 4u + command_count + 1u;
    argv = (char **)malloc(argv_count * sizeof(char *));
    if (!argv) return NULL;
    argv[argc++] = (char *)"bwrap";
    argv[argc++] = (char *)"--die-with-parent";
    argv[argc++] = (char *)"--proc"; argv[argc++] = (char *)"/proc";
    argv[argc++] = (char *)"--dev"; argv[argc++] = (char *)"/dev";
    argv[argc++] = (char *)"--tmpfs"; argv[argc++] = (char *)"/tmp";
    for (i = 0; i < BWRAP_READ_EXEC_PATH_COUNT; ++i) {
        argv[argc++] = (char *)"--ro-bind-try";
        argv[argc++] = (char *)bwrap_read_exec_paths[i];
        argv[argc++] = (char *)bwrap_read_exec_paths[i];
    }
    /* Read policy is a bounded read set, not a full-disk read: try variants
     * tolerate roots that do not exist. */
    for (i = 0; i < read_root_count; ++i) {
        argv[argc++] = (char *)"--ro-bind-try";
        argv[argc++] = (char *)read_roots[i];
        argv[argc++] = (char *)read_roots[i];
    }
    /* Generic read-only grants (sandbox.readOnlyPaths): same ro-bind tier. */
    for (i = 0; i < read_only_count; ++i) {
        argv[argc++] = (char *)"--ro-bind-try";
        argv[argc++] = (char *)read_only_paths[i];
        argv[argc++] = (char *)read_only_paths[i];
    }
    /* allowPaths keep the long-standing write tier (AppContainer merges them
     * into the write-root ACLs and Landlock grants the full handled set), so
     * all three backends agree; only readRoots/readOnlyPaths are read-only. */
    for (i = 0; i < allow_path_count; ++i) {
        argv[argc++] = (char *)"--bind-try";
        argv[argc++] = (char *)allow_paths[i];
        argv[argc++] = (char *)allow_paths[i];
    }
    /* Write roots mount after the read binds so a root present in both
     * lists (the session cwd by default) ends up writable. */
    for (i = 0; i < write_root_count; ++i) {
        argv[argc++] = (char *)"--bind";
        argv[argc++] = (char *)write_roots[i];
        argv[argc++] = (char *)write_roots[i];
    }
    /* Deny masks must mount after every write bind: the later mount shadows
     * the earlier one.  Directories get an inaccessible tmpfs, files a
     * /dev/null bind.  Paths that do not exist cannot be masked and are
     * skipped silently: the deny is vacuous for them, and the old stderr
     * diagnostic ran after the child's dup2, so it polluted the command's
     * stderr on every run (the default deny paths like .env usually do not
     * exist yet).  A deny path that is a symlink masks the target, so reads
     * stay blocked, but the link itself can be removed and recreated in a
     * writable parent directory: the mask is not a complete deny. */
    for (i = 0; i < deny_path_count; ++i) {
        struct stat st;
        if (lstat(deny_paths[i], &st) != 0) continue;
        if (S_ISDIR(st.st_mode)) {
            argv[argc++] = (char *)"--perms"; argv[argc++] = (char *)"000";
            argv[argc++] = (char *)"--tmpfs"; argv[argc++] = (char *)deny_paths[i];
        } else {
            argv[argc++] = (char *)"--ro-bind";
            argv[argc++] = (char *)"/dev/null";
            argv[argc++] = (char *)deny_paths[i];
        }
    }
    if (!allow_network) argv[argc++] = (char *)"--unshare-net";
    argv[argc++] = (char *)"--chdir"; argv[argc++] = (char *)cwd;
    argv[argc++] = (char *)"--";
    for (i = 0; i < command_count; ++i) argv[argc++] = command_argv[i];
    argv[argc] = NULL;
    return argv;
}

#else /* !__linux__ */

void owc_bwrap_probe(owc_sandbox_result *result) {
    if (!result) return;
    result->status = OWC_SANDBOX_ADVISORY;
    result->abi = 0;
    result->error_number = ENOSYS;
    (void)snprintf(result->reason, sizeof(result->reason),
                   "bubblewrap is only available on Linux");
}

char **owc_bwrap_build_argv(const char *cwd,
                            const char *const *read_roots, size_t read_root_count,
                            const char *const *read_only_paths, size_t read_only_count,
                            const char *const *write_roots, size_t write_root_count,
                            const char *const *deny_paths, size_t deny_path_count,
                            const char *const *allow_paths, size_t allow_path_count,
                            int allow_network, char *const *command_argv) {
    (void)cwd; (void)read_roots; (void)read_root_count;
    (void)read_only_paths; (void)read_only_count;
    (void)write_roots; (void)write_root_count;
    (void)deny_paths; (void)deny_path_count;
    (void)allow_paths; (void)allow_path_count;
    (void)allow_network; (void)command_argv;
    return NULL;
}

#endif
