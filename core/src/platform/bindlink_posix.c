#include "../bindlink.h"

#include <stdio.h>
#include <sys/stat.h>

int owc_bindlink_supported(void) { return 0; }

int owc_bindlink_create(const char *virt_path, const char *backing_path,
                        int read_only, char *err, size_t err_size) {
    (void)virt_path; (void)backing_path; (void)read_only;
    if (err && err_size) (void)snprintf(err,err_size,"bind links are only supported on Windows");
    return 0;
}

void owc_bindlink_remove(const char *virt_path) { (void)virt_path; }

int owc_bindlink_is_directory(const char *path) {
    struct stat st;
    return path && stat(path,&st)==0 && S_ISDIR(st.st_mode);
}
