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
   APPCONTAINER is the default; JOBOBJECT forces the Job Object compatibility
   path on Windows; OFF disables enforcement (same as sandbox.enabled=false).
   POSIX treats OFF like disabled and ignores the other two (landlock as-is). */
typedef enum {
    OWC_SANDBOX_MODE_APPCONTAINER = 0,
    OWC_SANDBOX_MODE_JOBOBJECT = 1,
    OWC_SANDBOX_MODE_OFF = 2
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
#else
void owc_landlock_probe(int allow_network, owc_sandbox_result *result);
int owc_landlock_apply(const char *cwd, int allow_network, owc_sandbox_result *result);
#endif

#endif
