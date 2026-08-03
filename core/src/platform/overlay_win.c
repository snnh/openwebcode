#include "../overlay.h"

#include <stdio.h>

/* Windows stub: overlayfs is a Linux mechanism.  Mirrors the bindlink_posix
 * pure-stub pattern: supported() reports 0 (core.ping advertises
 * supported:false) and every operation fails cleanly with a stable reason. */

int owc_overlay_supported(void) { return 0; }

void owc_overlay_probe(owc_overlay_capabilities *caps) {
    if (caps) {
        caps->supported=0;
        caps->fuse_overlayfs=0;
        caps->kernel_mount=0;
    }
}

static int unsupported(char *err, size_t err_size) {
    if (err && err_size) (void)snprintf(err,err_size,"overlay snapshot primitives are only supported on Linux");
    return 0;
}

int owc_overlay_mount(const char *state_root, const char *lower,
                      const char *upper, const char *work, const char *merged,
                      int *method, char *err, size_t err_size) {
    (void)state_root; (void)lower; (void)upper; (void)work; (void)merged; (void)method;
    return unsupported(err,err_size);
}

int owc_overlay_unmount(const char *merged, char *err, size_t err_size) {
    (void)merged;
    return unsupported(err,err_size);
}

int owc_overlay_copy_tree(const char *state_root, const char *source,
                          const char *dest, owc_overlay_copy_summary *summary,
                          char *err, size_t err_size) {
    (void)state_root; (void)source; (void)dest; (void)summary;
    return unsupported(err,err_size);
}

int owc_overlay_clear_dir(const char *state_root, const char *path,
                          char *err, size_t err_size) {
    (void)state_root; (void)path;
    return unsupported(err,err_size);
}
