#include "path_policy.h"

#include <limits.h>
#include <stdlib.h>
#include <string.h>

int owc_path_resolve(const char *input, char *output, size_t output_size) {
    char *resolved;
    if(!input || !output || !output_size) return 0;
    resolved=realpath(input,NULL); if(!resolved) return 0;
    if(strlen(resolved)+1>output_size) { free(resolved); return 0; }
    (void)strcpy(output,resolved); free(resolved); return 1;
}
