#ifndef OWC_PLATFORM_MEM_H
#define OWC_PLATFORM_MEM_H

#include <stddef.h>

/* Current resident set size of this process in bytes (working set on
 * Windows). Returns 0 when the platform cannot report it. */
size_t owc_process_rss_bytes(void);

#endif
