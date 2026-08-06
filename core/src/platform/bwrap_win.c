#include "../bwrap.h"

#include <errno.h>
#include <stdio.h>

/* Windows stub: bubblewrap is a Linux namespace sandbox, so the probe
 * always reports unavailable and exec never runs. */

void owc_bwrap_probe(owc_sandbox_result *result) {
    if (!result) return;
    result->status = OWC_SANDBOX_ADVISORY;
    result->abi = 0;
    result->error_number = ENOSYS;
    (void)snprintf(result->reason, sizeof(result->reason),
                   "bubblewrap is only available on Linux");
}

int owc_bwrap_exec(const char *cwd,
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
    return ENOSYS;
}
