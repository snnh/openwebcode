#ifndef OWC_FS_PLATFORM_H
#define OWC_FS_PLATFORM_H

#include "../fs.h"

typedef struct { unsigned char *data; size_t length; } owc_fs_bytes;
owc_fs_error owc_fs_platform_read(const char *root, const char *path, owc_fs_bytes *bytes);
owc_fs_error owc_fs_platform_write(const char *root, const char *path, const unsigned char *data, size_t length, int create_dirs);
owc_fs_error owc_fs_platform_stat(const char *root, const char *path, owc_fs_stat_result *result);
owc_fs_error owc_fs_platform_list(const char *root, const char *path, owc_fs_list_result *result);
owc_fs_error owc_fs_platform_watch_open(const char *root, const char *path, int recursive, owc_fs_watch **watch);
owc_fs_error owc_fs_platform_watch_poll(owc_fs_watch *watch, size_t maximum_events, owc_fs_watch_result *result);
void owc_fs_platform_watch_close(owc_fs_watch *watch);
/* Session deny roots consulted after the platform resolves the final on-disk
 * path, so junction / 8.3 short-name / trailing-dot spellings of a denied
 * directory cannot bypass the policy-layer textual comparison.  The array is
 * borrowed, not copied: callers refresh it before each filesystem operation
 * (the RPC dispatch loop is single-threaded for filesystem calls). */
void owc_fs_platform_set_deny_roots(const char *const *roots, size_t count);
/* Session bind links (Windows Bind Link API): virt paths inside the session
 * write roots that the user explicitly mapped to outside backing directories.
 * The fs layer uses the list to admit those controlled redirections in the
 * reparse and canonical-path checks; an empty list (the default) changes no
 * behavior.  Same ownership/threading rules as the deny roots above. */
void owc_fs_platform_set_bind_links(const char *const *virt_paths, const char *const *backing_paths, size_t count);

#endif
