#ifndef OWC_SANDBOX_H
#define OWC_SANDBOX_H

#include <stddef.h>

#ifdef _WIN32
#include <windows.h>
#endif

typedef enum {
    OWC_SANDBOX_ADVISORY = 0,
    OWC_SANDBOX_PARTIAL = 1,
    OWC_SANDBOX_ENFORCED = 2
} owc_sandbox_status;

/* Sandbox backend requested via session.configure sandbox.mode.
   APPCONTAINER is the default on Windows; JOBOBJECT forces the Job Object
   compatibility path on Windows; OFF disables enforcement (same as
   sandbox.enabled=false).  On POSIX the default backend is bubblewrap only,
   with no silent Landlock fallback: Landlock cannot express denyPaths, so
   falling back would quietly weaken isolation - an unusable bubblewrap
   fails closed with guidance instead.  LANDLOCK explicitly selects the
   Landlock compatibility backend (denyPaths unenforced for commands,
   reported partial); BUBBLEWRAP explicitly selects the default.  POSIX
   treats OFF like disabled and ignores the Windows values (APPCONTAINER/
   JOBOBJECT both select the default bubblewrap backend); Windows rejects
   the POSIX values with -32602 at configure time. */
typedef enum {
    OWC_SANDBOX_MODE_APPCONTAINER = 0,
    OWC_SANDBOX_MODE_JOBOBJECT = 1,
    OWC_SANDBOX_MODE_OFF = 2,
    OWC_SANDBOX_MODE_LANDLOCK = 3,
    OWC_SANDBOX_MODE_BUBBLEWRAP = 4
} owc_sandbox_mode;

typedef struct {
    owc_sandbox_status status;
    int abi;
    int error_number;
    char reason[192];
} owc_sandbox_result;

typedef struct {
    const char *session_id;
    int allow_network;
    const char *const *write_roots;
    size_t write_root_count;
    /* Windows only (the struct is shared across platforms): Bind Link
       backing directories granted to the AppContainer so sandboxed
       processes can reach the bound tree through its virtPath.  A nonzero
       bind_read_only[i] grants read/traverse/execute only; zero grants the
       same read/write tier as a write root.  POSIX ignores these. */
    const char *const *bind_backing;
    const int *bind_read_only;
    size_t bind_count;
    /* Generic read-only grants (session.configure sandbox.readOnlyPaths):
       the same read/traverse/execute tier as a read-only Bind Link backing.
       Windows grants them to the AppContainer; the POSIX backends apply them
       through the exec/pty request chain instead (bwrap ro-binds, Landlock
       read+execute rules), so this member is unused there. */
    const char *const *read_only_paths;
    size_t read_only_count;
    /* Session deny paths (session.configure sandbox.denyPaths).  Windows
       only: AppContainer file access is dual-principal and the package leg
       is allow-only - a DENY ACE for the package SID does NOT sink it
       (verified empirically: deny + allow for the same package SID still
       reads), so enforcement strips this command's own package-SID ACEs
       from each existing deny path after the write-root grant propagated
       them; without a package-leg allow the object is unreachable for the
       sandboxed process.  Missing paths are skipped; a strip failure on an
       existing path fails the whole create (fail-closed).  POSIX enforces
       deny paths at the fs.* RPC layer and, under bubblewrap, through
       mount masks, so this member is unused there. */
    const char *const *deny_paths;
    size_t deny_count;
    /* With allow_network: also grant privateNetworkClientServer
       (S-1-15-3-3), which the filtered-mode sidecar needs to reach an
       upstream proxy on a LAN address.  Windows only. */
    int private_network;
    /* Windows filtered-network sessions keep one fixed AppContainer profile
       (OpenWebCode.<session-id>) whose profile and ACL lifecycle is owned by
       owc_sandbox_session_grant/revoke: create derives the existing SID,
       skips every ACL grant/revoke, and never deletes the profile.  Zero
       keeps the per-command Run.* lifecycle. */
    int shared_profile;
} owc_sandbox_options;

typedef struct owc_sandbox owc_sandbox;

owc_sandbox_status owc_sandbox_probe(char *reason, size_t reason_size);
const char *owc_sandbox_status_name(owc_sandbox_status status);

#ifdef _WIN32
owc_sandbox *owc_sandbox_create(const owc_sandbox_options *options,
                                char *reason, size_t reason_size);
int owc_sandbox_add_process_attribute(owc_sandbox *sandbox,
                                      LPPROC_THREAD_ATTRIBUTE_LIST attributes,
                                      char *reason, size_t reason_size);
owc_sandbox_status owc_sandbox_get_status(const owc_sandbox *sandbox);
void owc_sandbox_destroy(owc_sandbox *sandbox);
/* Session-scoped AppContainer profile/ACL lifecycle for filtered-network
   sessions (Windows only).  grant creates the fixed OpenWebCode.<session-id>
   profile and grants the write roots (read/write), read-only paths, and Bind
   Link backings from options; it is idempotent (a repeated grant for the same
   session revokes the previous one first) and bounded to 16 sessions.  revoke
   undoes the grants and deletes the profile; revoke_all is the process-exit
   fallback. */
int owc_sandbox_session_grant(const char *session_id,
                              const owc_sandbox_options *options,
                              char *reason, size_t reason_size);
void owc_sandbox_session_revoke(const char *session_id);
void owc_sandbox_session_revoke_all(void);
#else
void owc_landlock_probe(int allow_network, owc_sandbox_result *result);
/* Landlock rules are purely additive, so denyPaths cannot be expressed
 * here: they stay enforced at the fs.* RPC layer (and by bubblewrap masks
 * when that backend is active).  cwd and write_roots get the full handled
 * access set, allow_paths keep their historical read/write tier, read_roots
 * and read_only_paths get read+execute only. */
int owc_landlock_apply(const char *cwd, const char *const *allow_paths,
                       size_t allow_path_count,
                       const char *const *read_roots, size_t read_root_count,
                       const char *const *read_only_paths,
                       size_t read_only_count,
                       const char *const *write_roots, size_t write_root_count,
                       int allow_network,
                       owc_sandbox_result *result);
/* Runtime exemption tables applied by owc_landlock_apply (see
 * sandbox_posix.c).  Exposed for test assertions. */
extern const char *const owc_landlock_read_exec_paths[];
extern const size_t owc_landlock_read_exec_path_count;
extern const char *const owc_landlock_full_access_paths[];
extern const size_t owc_landlock_full_access_path_count;
#endif

#endif
