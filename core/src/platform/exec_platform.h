#ifndef OWC_PLATFORM_EXEC_H
#define OWC_PLATFORM_EXEC_H

#include "exec.h"

int owc_platform_exec_run(const owc_exec_request *request, owc_exec_result *result);

/* POSIX only: SIGKILL every spawned child process group still tracked, so a
 * core exit (normal or fatal signal) does not orphan them.  Async-signal-safe. */
void owc_platform_exec_terminate_all(void);

#endif
