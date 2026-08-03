#ifndef OWC_OVERLAY_H
#define OWC_OVERLAY_H

#include <stddef.h>

/* Overlayfs snapshot primitives (Linux only).  These are trusted host-level
 * operations like the PTY and bind-link primitives: core itself is not a
 * sandboxed process.  Every path argument is validated by the RPC layer
 * (absolute, no dot components, root-bound under the caller-supplied
 * stateRoot) before any primitive runs; the POSIX implementation re-resolves
 * paths with realpath and refuses symlink escapes before touching the fs.
 *
 * Mount mechanism: euid==0 uses the kernel overlay mount(2); any other user
 * needs fuse-overlayfs on PATH.  Unprivileged user-namespace mounts are not
 * implemented (the mount would die with the helper process), so kernelMount
 * honestly reports geteuid()==0 only. */

typedef struct {
    int supported;       /* any mount mechanism usable by this process */
    int fuse_overlayfs;  /* fuse-overlayfs found on PATH */
    int kernel_mount;    /* geteuid()==0: mount(2) overlay is usable */
} owc_overlay_capabilities;

void owc_overlay_probe(owc_overlay_capabilities *caps);
int owc_overlay_supported(void);

/* Which mount mechanism was used for a merged directory (kept in memory by
 * the POSIX implementation so unmount picks the matching umount path). */
#define OWC_OVERLAY_METHOD_KERNEL 1
#define OWC_OVERLAY_METHOD_FUSE 2

typedef struct {
    unsigned long long files;   /* regular files and symlinks copied */
    unsigned long long bytes;   /* regular-file content bytes copied */
    unsigned long long skipped; /* special entries not copied (see protocol.md) */
} owc_overlay_copy_summary;

/* Create (idempotently) upper/work/merged and mount the overlay.  work and
 * merged must be empty directories; upper must be a directory and may hold a
 * previous upper layer (restore remounts a populated upper).  On failure
 * returns 0, stores a short ASCII reason in err, and leaves no half-mounted
 * state behind. */
int owc_overlay_mount(const char *state_root, const char *lower,
                      const char *upper, const char *work, const char *merged,
                      int *method, char *err, size_t err_size);

/* Unmount merged.  Idempotent: an unknown or not-mounted merged is a
 * success (the in-memory mount-method table is lost on core restart, so an
 * unknown merged is first tried with umount2, then fusermount3/fusermount). */
int owc_overlay_unmount(const char *merged, char *err, size_t err_size);

/* Recursively copy source into dest.  dest either does not exist yet (it is
 * created, missing parents included) or is an existing empty directory
 * (restore fills the cleared upper).  Regular files prefer
 * FICLONE/copy_file_range and degrade to a plain copy; permission bits are
 * preserved, xattrs are copied best effort (fuse-overlayfs whiteouts live in
 * xattrs).  Symlinks are recreated, never followed.  Special files are
 * recreated only when euid==0, otherwise counted in summary->skipped. */
int owc_overlay_copy_tree(const char *state_root, const char *source,
                          const char *dest, owc_overlay_copy_summary *summary,
                          char *err, size_t err_size);

/* Remove every child of path (the directory itself stays).  Symlinks are
 * unlinked, never followed. */
int owc_overlay_clear_dir(const char *state_root, const char *path,
                          char *err, size_t err_size);

#endif
