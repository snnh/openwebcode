#include "rpc.h"

#include <stdio.h>
#include <stdlib.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#endif

int main(void) {
    owc_rpc rpc={stdin,stdout,0};
#ifdef _WIN32
    if(_setmode(_fileno(stdin),_O_BINARY)==-1 || _setmode(_fileno(stdout),_O_BINARY)==-1) return 1;
#endif
    while(!rpc.shutting_down) {
        char *body=NULL; size_t length=0; int status=owc_rpc_read(&rpc,&body,&length);
        if(status==0) break;
        if(status<0) { fprintf(stderr,"owc-exec: invalid RPC frame\n"); free(body); return 2; }
        (void)owc_rpc_dispatch(&rpc,body,length); free(body);
    }
    return 0;
}
