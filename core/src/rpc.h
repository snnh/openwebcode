#ifndef OWC_RPC_H
#define OWC_RPC_H

#include <stddef.h>
#include <stdio.h>

#define OWC_RPC_MAX_MESSAGE (16u * 1024u * 1024u)

typedef struct { FILE *input; FILE *output; int shutting_down; } owc_rpc;

int owc_rpc_read(owc_rpc *rpc, char **body, size_t *length);
int owc_rpc_write(owc_rpc *rpc, const char *body, size_t length);
int owc_rpc_dispatch(owc_rpc *rpc, const char *body, size_t length);

#endif
