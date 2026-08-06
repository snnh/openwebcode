#ifndef OWC_BWRAP_H
#define OWC_BWRAP_H

#include <stddef.h>

#include "sandbox.h"

/* bubblewrap (bwrap) sandbox backend, Linux only.  bwrap builds a namespace
 * sandbox around the command: a fresh tmpfs root, the system trees bound
 * read-only, the session roots bound per policy (read/write roots over the
 * same paths shadow earlier read-only binds), deny paths masked afterwards
 * (later mounts shadow earlier ones), and an optional network namespace cut
 * via --unshare-net.  Unlike Landlock the policy is subtractive, so
 * denyPaths are honored inside the sandboxed process rather than only at
 * the fs.* RPC layer.
 *
 * Non-Linux builds provide stubs: the probe always reports unavailable and
 * owc_bwrap_exec only returns ENOSYS. */

/* One-shot cached probe (InitOnce semantics): bwrap must be on PATH and a
 * real smoke run (user namespace + bind mount + exec of /bin/true) must
 * succeed.  Success reports OWC_SANDBOX_ENFORCED; any failure reports
 * OWC_SANDBOX_ADVISORY with the captured stderr tail in reason, which covers
 * disabled unprivileged user namespaces and the Ubuntu 24.04 AppArmor
 * restriction on them.  The cached result is cheap to query afterwards. */
void owc_bwrap_probe(owc_sandbox_result *result);

/* Exec command_argv under bwrap with the session policy applied.  Only
 * returns when the bwrap exec itself failed, handing back the exec errno;
 * on success the process image has been replaced and this does not return.
 * Callers run this in the forked child, after resource limits and after the
 * sandbox status pipe has been written. */
int owc_bwrap_exec(const char *cwd,
                   const char *const *read_roots, size_t read_root_count,
                   const char *const *read_only_paths, size_t read_only_count,
                   const char *const *write_roots, size_t write_root_count,
                   const char *const *deny_paths, size_t deny_path_count,
                   const char *const *allow_paths, size_t allow_path_count,
                   int allow_network, char *const *command_argv);

#endif
