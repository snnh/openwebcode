#include "exec.h"
#include "platform/exec_platform.h"

#include <string.h>

int owc_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    owc_exec_request normalized;
    if (!result) return 0;
    /* Zero the result before any early return so callers that inspect it on
     * failure never read uninitialized memory. */
    memset(result, 0, sizeof(*result));
    if (!request || !request->command || !request->command[0] ||
        !request->cwd || !request->cwd[0]) {
        return 0;
    }
    normalized = *request;
    /* timeout_ms <= 0 means no timeout: the caller (server) owns the soft
     * limit so the CLI and one-shot exec paths do not impose a hidden 120s
     * cap. */
    if (normalized.output_limit == 0) normalized.output_limit = 10u * 1024u * 1024u;
    return owc_platform_exec_run(&normalized, result);
}
