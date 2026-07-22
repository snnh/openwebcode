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

#endif
