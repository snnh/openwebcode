#include "exec.h"
#include "platform/exec_platform.h"

#include <string.h>

int owc_exec_run(const owc_exec_request *request, owc_exec_result *result) {
    owc_exec_request normalized;
    if (!request || !result || !request->command || !request->command[0] ||
        !request->cwd || !request->cwd[0]) {
        return 0;
    }
    normalized = *request;
    if (normalized.timeout_ms <= 0) normalized.timeout_ms = 120000;
    if (normalized.output_limit == 0) normalized.output_limit = 10u * 1024u * 1024u;
    memset(result, 0, sizeof(*result));
    return owc_platform_exec_run(&normalized, result);
}
