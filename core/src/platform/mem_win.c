#include "platform/mem_platform.h"

#include <windows.h>
#include <psapi.h>

/* Working set is the Windows counterpart of the resident set: the physical
 * pages backing this process right now. GetProcessMemoryInfo is exported
 * from psapi (redirected to KernelBase on Windows 7+). */
size_t owc_process_rss_bytes(void) {
    PROCESS_MEMORY_COUNTERS counters;
    if (!GetProcessMemoryInfo(GetCurrentProcess(), &counters,
                              sizeof(counters))) {
        return 0;
    }
    return (size_t)counters.WorkingSetSize;
}
