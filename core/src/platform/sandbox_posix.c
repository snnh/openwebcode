#include "sandbox.h"

#include <errno.h>
#include <stdio.h>
#include <string.h>

#if defined(__linux__) && defined(__has_include)
# if __has_include(<linux/landlock.h>)
#  define OWC_HAVE_LANDLOCK_HEADER 1
# endif
#endif

#ifdef OWC_HAVE_LANDLOCK_HEADER
#include <fcntl.h>
#include <linux/landlock.h>
#include <sys/prctl.h>
#include <sys/stat.h>
#include <sys/syscall.h>
#include <unistd.h>

#if defined(__NR_landlock_create_ruleset) && defined(__NR_landlock_add_rule) && defined(__NR_landlock_restrict_self)
#define OWC_HAVE_LANDLOCK_SYSCALLS 1
#endif
#endif

static void set_result(owc_sandbox_result *result, owc_sandbox_status status,
                       int abi, int error_number, const char *reason) {
    result->status = status;
    result->abi = abi;
    result->error_number = error_number;
    (void)snprintf(result->reason, sizeof(result->reason), "%s", reason);
}

const char *owc_sandbox_status_name(owc_sandbox_status status) {
    if (status == OWC_SANDBOX_ENFORCED) return "enforced";
    if (status == OWC_SANDBOX_PARTIAL) return "partial";
    return "advisory";
}

#if defined(OWC_HAVE_LANDLOCK_SYSCALLS)
static int landlock_create(const struct landlock_ruleset_attr *attr, size_t size,
                           unsigned int flags) {
    return (int)syscall(__NR_landlock_create_ruleset, attr, size, flags);
}

static int landlock_add(int ruleset_fd, const struct landlock_path_beneath_attr *attr) {
    return (int)syscall(__NR_landlock_add_rule, ruleset_fd,
                        LANDLOCK_RULE_PATH_BENEATH, attr, 0U);
}

static int landlock_restrict(int ruleset_fd) {
    return (int)syscall(__NR_landlock_restrict_self, ruleset_fd, 0U);
}

static unsigned long long fs_access_for_abi(int abi) {
    unsigned long long access = LANDLOCK_ACCESS_FS_EXECUTE |
        LANDLOCK_ACCESS_FS_WRITE_FILE | LANDLOCK_ACCESS_FS_READ_FILE |
        LANDLOCK_ACCESS_FS_READ_DIR | LANDLOCK_ACCESS_FS_REMOVE_DIR |
        LANDLOCK_ACCESS_FS_REMOVE_FILE | LANDLOCK_ACCESS_FS_MAKE_CHAR |
        LANDLOCK_ACCESS_FS_MAKE_DIR | LANDLOCK_ACCESS_FS_MAKE_REG |
        LANDLOCK_ACCESS_FS_MAKE_SOCK | LANDLOCK_ACCESS_FS_MAKE_FIFO |
        LANDLOCK_ACCESS_FS_MAKE_BLOCK | LANDLOCK_ACCESS_FS_MAKE_SYM;
#ifdef LANDLOCK_ACCESS_FS_REFER
    if (abi >= 2) access |= LANDLOCK_ACCESS_FS_REFER;
#endif
#ifdef LANDLOCK_ACCESS_FS_TRUNCATE
    if (abi >= 3) access |= LANDLOCK_ACCESS_FS_TRUNCATE;
#endif
#ifdef LANDLOCK_ACCESS_FS_IOCTL_DEV
    if (abi >= 5) access |= LANDLOCK_ACCESS_FS_IOCTL_DEV;
#endif
    return access;
}

static int add_path_rule(int ruleset_fd, const char *path,
                         unsigned long long access, int required,
                         owc_sandbox_result *result) {
    struct landlock_path_beneath_attr rule;
    int fd = open(path, O_PATH | O_CLOEXEC);
    if (fd < 0) {
        if (!required && errno == ENOENT) {
            /* A missing optional root is skipped, but say so: core stderr is
             * archived by the server, which makes a silently narrowed policy
             * debuggable. */
            (void)dprintf(STDERR_FILENO,
                          "owc-exec: sandbox rule path skipped (ENOENT): %s\n", path);
            return 1;
        }
        set_result(result, OWC_SANDBOX_ADVISORY, result->abi, errno,
                   "failed to open sandbox rule path");
        return 0;
    }
    memset(&rule, 0, sizeof(rule));
    rule.allowed_access = access;
    rule.parent_fd = fd;
    if (landlock_add(ruleset_fd, &rule) != 0) {
        int saved = errno;
        (void)close(fd);
        set_result(result, OWC_SANDBOX_ADVISORY, result->abi, saved,
                   "failed to add Landlock path rule");
        return 0;
    }
    (void)close(fd);
    return 1;
}
#endif

void owc_landlock_probe(int allow_network, owc_sandbox_result *result) {
#if defined(OWC_HAVE_LANDLOCK_SYSCALLS)
    int abi = landlock_create(NULL, 0, LANDLOCK_CREATE_RULESET_VERSION);
    if (abi < 0) {
        int saved = errno;
        set_result(result, OWC_SANDBOX_ADVISORY, 0, saved,
                   saved == ENOSYS ? "Landlock is unavailable in this kernel" :
                   "Landlock ABI query failed");
        return;
    }
#if defined(LANDLOCK_ACCESS_NET_BIND_TCP) && defined(LANDLOCK_ACCESS_NET_CONNECT_TCP)
    if (!allow_network && abi < 4) {
        set_result(result, OWC_SANDBOX_PARTIAL, abi, 0,
                   "filesystem isolation available; network denial requires Landlock ABI 4");
        return;
    }
#else
    if (!allow_network) {
        set_result(result, OWC_SANDBOX_PARTIAL, abi, 0,
                   "filesystem isolation available; build headers lack Landlock network support");
        return;
    }
#endif
    set_result(result, OWC_SANDBOX_ENFORCED, abi, 0,
               "Landlock isolation is available");
#else
    (void)allow_network;
# if defined(__linux__)
    set_result(result, OWC_SANDBOX_ADVISORY, 0, ENOSYS,
               "Landlock headers or syscall numbers are unavailable at build time");
# else
    set_result(result, OWC_SANDBOX_ADVISORY, 0, ENOSYS,
               "Landlock is only available on Linux");
# endif
#endif
}

owc_sandbox_status owc_sandbox_probe(char *reason, size_t reason_size) {
    owc_sandbox_result result;
    owc_landlock_probe(1, &result);
    if (reason && reason_size) (void)snprintf(reason, reason_size, "%s", result.reason);
    return result.status;
}

/* Runtime exemption tables: paths every Landlock-sandboxed process may reach
 * in addition to the session cwd and allow paths.  read_exec entries are
 * granted read+execute only (system binaries, configuration, kernel pseudo
 * filesystems); full_access entries are granted the complete handled access
 * set (scratch space and device nodes).  Non-static so test_sandbox can
 * assert their contents. */
const char *const owc_landlock_read_exec_paths[] = {
    "/usr", "/bin", "/lib", "/lib64", "/etc", "/proc", "/sys"
};
const size_t owc_landlock_read_exec_path_count =
    sizeof(owc_landlock_read_exec_paths) / sizeof(owc_landlock_read_exec_paths[0]);
const char *const owc_landlock_full_access_paths[] = {"/tmp", "/dev"};
const size_t owc_landlock_full_access_path_count =
    sizeof(owc_landlock_full_access_paths) / sizeof(owc_landlock_full_access_paths[0]);

int owc_landlock_apply(const char *cwd, const char *const *allow_paths,
                       size_t allow_path_count,
                       const char *const *read_roots, size_t read_root_count,
                       const char *const *read_only_paths,
                       size_t read_only_count,
                       const char *const *write_roots, size_t write_root_count,
                       int allow_network,
                       owc_sandbox_result *result) {
#if defined(OWC_HAVE_LANDLOCK_SYSCALLS)
    struct landlock_ruleset_attr ruleset;
    unsigned long long read_exec;
    unsigned long long handled;
    int ruleset_fd;
    size_t i;

    owc_landlock_probe(allow_network, result);
    if (result->abi <= 0) return 0;
    handled = fs_access_for_abi(result->abi);
    memset(&ruleset, 0, sizeof(ruleset));
    ruleset.handled_access_fs = handled;
#if defined(LANDLOCK_ACCESS_NET_BIND_TCP) && defined(LANDLOCK_ACCESS_NET_CONNECT_TCP)
    if (!allow_network && result->abi >= 4)
        ruleset.handled_access_net = LANDLOCK_ACCESS_NET_BIND_TCP |
                                     LANDLOCK_ACCESS_NET_CONNECT_TCP;
#endif
    ruleset_fd = landlock_create(&ruleset, sizeof(ruleset), 0U);
    if (ruleset_fd < 0) {
        set_result(result, OWC_SANDBOX_ADVISORY, result->abi, errno,
                   "failed to create Landlock ruleset");
        return 0;
    }
    read_exec = LANDLOCK_ACCESS_FS_EXECUTE | LANDLOCK_ACCESS_FS_READ_FILE |
                LANDLOCK_ACCESS_FS_READ_DIR;
    if (!add_path_rule(ruleset_fd, cwd, handled, 1, result)) goto fail;
    /* Session write roots beyond the cwd get the full read/write rule set,
     * read roots read+execute only.  Landlock rules are additive, so a root
     * listed in both sets (the cwd by default) ends up writable.  denyPaths
     * cannot be expressed in additive rules and stay enforced at the fs.*
     * RPC layer. */
    for (i = 0; i < write_root_count; ++i) {
        if (!add_path_rule(ruleset_fd, write_roots[i], handled, 0, result)) goto fail;
    }
    for (i = 0; i < allow_path_count; ++i) {
        if (!add_path_rule(ruleset_fd, allow_paths[i], handled, 0, result)) goto fail;
    }
    for (i = 0; i < read_root_count; ++i) {
        if (!add_path_rule(ruleset_fd, read_roots[i], read_exec, 0, result)) goto fail;
    }
    /* Generic read-only grants (sandbox.readOnlyPaths): same read+execute
       tier as the read roots. */
    for (i = 0; i < read_only_count; ++i) {
        if (!add_path_rule(ruleset_fd, read_only_paths[i], read_exec, 0, result)) goto fail;
    }
    for (i = 0; i < owc_landlock_read_exec_path_count; ++i) {
        if (!add_path_rule(ruleset_fd, owc_landlock_read_exec_paths[i], read_exec, 0, result)) goto fail;
    }
    for (i = 0; i < owc_landlock_full_access_path_count; ++i) {
        if (!add_path_rule(ruleset_fd, owc_landlock_full_access_paths[i], handled, 0, result)) goto fail;
    }
    if (prctl(PR_SET_NO_NEW_PRIVS, 1L, 0L, 0L, 0L) != 0) {
        set_result(result, OWC_SANDBOX_ADVISORY, result->abi, errno,
                   "failed to set no_new_privs");
        goto fail;
    }
    if (landlock_restrict(ruleset_fd) != 0) {
        set_result(result, OWC_SANDBOX_ADVISORY, result->abi, errno,
                   "failed to enforce Landlock ruleset");
        goto fail;
    }
    (void)close(ruleset_fd);
    return 1;
fail:
    (void)close(ruleset_fd);
    return 0;
#else
    (void)cwd;
    (void)allow_paths;
    (void)allow_path_count;
    (void)read_roots;
    (void)read_root_count;
    (void)read_only_paths;
    (void)read_only_count;
    (void)write_roots;
    (void)write_root_count;
    owc_landlock_probe(allow_network, result);
    return 0;
#endif
}
