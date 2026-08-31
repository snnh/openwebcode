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
 * owc_bwrap_build_argv returns NULL. */

/* One-shot cached probe (InitOnce semantics): bwrap must be on PATH and a
 * real smoke run (user namespace + bind mount + network namespace + exec of
 * /bin/true) must succeed.  Success reports OWC_SANDBOX_ENFORCED; a run
 * that fails because unprivileged network namespaces are forbidden reports
 * OWC_SANDBOX_PARTIAL (filesystem isolation still works, network deny does
 * not); every other failure reports OWC_SANDBOX_ADVISORY with the captured
 * stderr tail in reason, which covers disabled unprivileged user namespaces
 * and the Ubuntu 24.04 AppArmor restriction on them.  The cached result is
 * cheap to query afterwards. */
void owc_bwrap_probe(owc_sandbox_result *result);

/* Build the bwrap argv for command_argv with the session policy applied.
 * Must run in the parent BEFORE fork: the vector is malloc'd, and malloc
 * is not safe in the forked child of this multithreaded process (another
 * thread may hold the malloc arena lock at fork, deadlocking the child
 * before it ever execs).  Returns NULL on allocation failure; the caller
 * owns and frees the vector (the entries borrow the caller's strings).
 * The forked child only execvp()s the result. */
char **owc_bwrap_build_argv(const char *cwd,
                            const char *const *read_roots, size_t read_root_count,
                            const char *const *read_only_paths, size_t read_only_count,
                            const char *const *write_roots, size_t write_root_count,
                            const char *const *deny_paths, size_t deny_path_count,
                            const char *const *allow_paths, size_t allow_path_count,
                            int allow_network, char *const *command_argv);

#endif
