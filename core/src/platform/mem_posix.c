#include "platform/mem_platform.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Linux: /proc/self/status VmRSS is the current resident set (kB). The
 * process only targets Linux on POSIX (no macOS), so the procfs read is the
 * exact supported platform. */
size_t owc_process_rss_bytes(void) {
    FILE *status;
    char line[256];
    size_t bytes = 0;
    status = fopen("/proc/self/status", "r");
    if (!status) return 0;
    while (fgets(line, sizeof(line), status)) {
        if (strncmp(line, "VmRSS:", 6) == 0) {
            char *end = NULL;
            unsigned long long kib = strtoull(line + 6, &end, 10);
            if (end != line + 6) bytes = (size_t)(kib * 1024ull);
            break;
        }
    }
    fclose(status);
    return bytes;
}
