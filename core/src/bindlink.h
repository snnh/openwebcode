#ifndef OWC_BINDLINK_H
#define OWC_BINDLINK_H

#include <stddef.h>

/* Windows Bind Link API (bindflt.sys) access.  The API is resolved at runtime
 * (LoadLibrary/GetProcAddress) so the binary still starts on systems where
 * the DLL is absent; owc_bindlink_supported() reports that probe.  POSIX
 * builds always report unsupported and every create fails cleanly.
 *
 * Documented semantics (Microsoft Learn, bindlink overview): links are
 * system-wide, require Administrator privileges to create, and last until
 * RemoveBindLink or the next system shutdown.  Core therefore removes the
 * links it created when the owning session is cleaned up, re-configured, or
 * the process exits normally; a crashed core leaves stale links until reboot. */
int owc_bindlink_supported(void);

/* Create a bind link mapping virt_path to backing_path.  Returns 1 on
 * success; on failure returns 0 and, when err is provided, stores a short
 * ASCII reason.  Requires Administrator privileges on Windows. */
int owc_bindlink_create(const char *virt_path, const char *backing_path,
                        int read_only, char *err, size_t err_size);

/* Best-effort removal of a previously created bind link. */
void owc_bindlink_remove(const char *virt_path);

/* Backing path validation: the path exists and is a directory. */
int owc_bindlink_is_directory(const char *path);

#endif
