#include "sandbox.h"

#include <stdio.h>
#include <string.h>

int main(void) {
    char reason[256];
    owc_sandbox_status status = owc_sandbox_probe(reason, sizeof(reason));
    const char *name = owc_sandbox_status_name(status);
    if (status < OWC_SANDBOX_ADVISORY || status > OWC_SANDBOX_ENFORCED) return 1;
    if (!reason[0]) return 2;
    if (strcmp(name, "advisory") != 0 && strcmp(name, "partial") != 0 &&
        strcmp(name, "enforced") != 0) return 3;
#ifdef _WIN32
    if (status == OWC_SANDBOX_ENFORCED && strstr(reason, "available") == NULL) return 4;
#endif
    (void)printf("status=%s reason=%s\n", name, reason);
    return 0;
}
