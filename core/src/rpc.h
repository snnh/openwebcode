#ifndef OWC_RPC_H
#define OWC_RPC_H

#include <stddef.h>
#include <stdio.h>

/* 20 MiB PDFs are carried as base64 by the internal fs.writeBase64 RPC.
 * Their JSON envelope is just under 28 MiB, so leave bounded headroom while
 * retaining a finite parser/frame limit for every other RPC. */
#define OWC_RPC_MAX_MESSAGE (32u * 1024u * 1024u)

typedef struct { FILE *input; FILE *output; int shutting_down; int suppress_responses; } owc_rpc;

int owc_rpc_read(owc_rpc *rpc, char **body, size_t *length);
int owc_rpc_write(owc_rpc *rpc, const char *body, size_t length);
int owc_rpc_dispatch(owc_rpc *rpc, const char *body, size_t length);
/* Undo every session-owned bind link (Windows Bind Link API).  Call once on
 * the normal process exit path; links are system-wide and otherwise survive
 * the process until reboot. */
void owc_rpc_release_sessions(void);

#endif
