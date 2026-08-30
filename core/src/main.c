#include "rpc.h"

#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <fcntl.h>
#include <io.h>
#include <winsock2.h>
#include <ws2tcpip.h>
#pragma comment(lib, "ws2_32.lib")
#else
#include <fcntl.h>
#include <netdb.h>
#include <signal.h>
#include <sys/socket.h>
#include <sys/types.h>
#include <unistd.h>
#include "platform/exec_platform.h"
#include "pty.h"

/* Spawned jobs run in their own process groups; a core that exits (loop end
 * or fatal signal) must not leave them orphaned.  The handler re-raises with
 * the default disposition so the exit status still reflects the signal. */
static void on_fatal_signal(int sig) {
    owc_platform_exec_terminate_all();
    owc_pty_terminate_all();
    (void)signal(sig,SIG_DFL);
    (void)raise(sig);
}
#endif

static void usage(void) {
    fprintf(stderr, "usage: owc-exec [--connect <host:port>]\n");
}

/* Parses "host:port"; host may be bracketed IPv6 ([::1]:8080). Returns 1 on success. */
static int parse_connect_target(const char *value, char *host, size_t host_size, char *port, size_t port_size) {
    const char *colon, *host_begin=value, *host_end;
    size_t host_length, port_length;
    if (!value || !value[0]) return 0;
    if (value[0]=='[') {
        const char *close=strchr(value, ']');
        if (!close || close[1]!=':') return 0;
        host_begin=value+1; host_end=close; colon=close+1;
    } else {
        colon=strrchr(value, ':');
        if (!colon || strchr(value, ':')!=colon) return 0; /* reject unbracketed IPv6 */
        host_end=colon;
    }
    host_length=(size_t)(host_end-host_begin); port_length=strlen(colon+1);
    if (!host_length || !port_length || host_length>=host_size || port_length>=port_size) return 0;
    memcpy(host, host_begin, host_length); host[host_length]='\0';
    memcpy(port, colon+1, port_length+1);
    return 1;
}

static intptr_t socket_connect(const char *host, const char *port) {
#ifdef _WIN32
    SOCKET sock=INVALID_SOCKET;
#else
    int sock=-1;
#endif
    struct addrinfo hints, *list=NULL, *it;
    int connected=0;
    memset(&hints,0,sizeof(hints));
    hints.ai_family=AF_UNSPEC; hints.ai_socktype=SOCK_STREAM; hints.ai_protocol=IPPROTO_TCP;
    if (getaddrinfo(host,port,&hints,&list)!=0) return -1;
    for (it=list; it && !connected; it=it->ai_next) {
#ifdef _WIN32
        /* dwFlags=0: a plain socket() handle is overlapped, which makes CRT
           ReadFile/_read fail with ERROR_INVALID_PARAMETER. */
        sock=WSASocketW(it->ai_family,it->ai_socktype,it->ai_protocol,NULL,0,0);
#else
        sock=socket(it->ai_family,it->ai_socktype,it->ai_protocol);
#endif
#ifdef _WIN32
        if (sock==INVALID_SOCKET) continue;
        if (connect(sock,it->ai_addr,(int)it->ai_addrlen)==SOCKET_ERROR) { closesocket(sock); sock=INVALID_SOCKET; continue; }
#else
        if (sock<0) continue;
        if (connect(sock,it->ai_addr,it->ai_addrlen)!=0) { close(sock); sock=-1; continue; }
#endif
        connected=1;
    }
    freeaddrinfo(list);
#ifdef _WIN32
    return connected ? (intptr_t)sock : -1;
#else
    return connected ? (intptr_t)sock : -1;
#endif
}

/* Wraps a connected socket in a read FILE* and an independent write FILE*. */
static int socket_streams(intptr_t socket_handle, FILE **input, FILE **output) {
#ifdef _WIN32
    int fd=(int)_open_osfhandle(socket_handle, 0);
    int duplicate;
    if (fd<0) { closesocket((SOCKET)socket_handle); return 0; }
    duplicate=_dup(fd);
    if (duplicate<0) { _close(fd); return 0; }
    *input=_fdopen(fd,"rb");
    *output=_fdopen(duplicate,"wb");
#else
    int flags;
    int duplicate;
    /* The --connect descriptors carry the RPC stream; without CLOEXEC they
     * would be inherited by spawned commands (and sandboxed ones at that),
     * handing the session's RPC channel to the child. */
    flags = fcntl((int)socket_handle, F_GETFD, 0);
    if (flags < 0 || fcntl((int)socket_handle, F_SETFD, flags | FD_CLOEXEC) < 0) {
        close((int)socket_handle);
        return 0;
    }
    duplicate = dup((int)socket_handle);
    if (duplicate < 0) { close((int)socket_handle); return 0; }
    flags = fcntl(duplicate, F_GETFD, 0);
    if (flags < 0 || fcntl(duplicate, F_SETFD, flags | FD_CLOEXEC) < 0) {
        close(duplicate);
        close((int)socket_handle);
        return 0;
    }
    *input = fdopen((int)socket_handle, "r");
    *output = fdopen(duplicate, "w");
#endif
    if (!*input || !*output) {
#ifdef _WIN32
        if (*input) fclose(*input); else _close(fd);
        if (*output) fclose(*output); else _close(duplicate);
#else
        if (*input) fclose(*input); else close((int)socket_handle);
        if (*output) fclose(*output); else close(duplicate);
#endif
        return 0;
    }
    /* Responses must reach the host immediately; stdio defaults to full buffering on pipes/sockets. */
    (void)setvbuf(*output, NULL, _IONBF, 0);
    return 1;
}

int main(int argc, char **argv) {
    owc_rpc rpc={stdin,stdout,0,0};
    const char *target=NULL;
    char host[256], port[16];
    int i;
    intptr_t socket_handle=-1;
    FILE *input=NULL, *output=NULL;
#ifdef _WIN32
    WSADATA wsa;
#else
    (void)signal(SIGTERM,on_fatal_signal);
    (void)signal(SIGINT,on_fatal_signal);
    (void)signal(SIGHUP,on_fatal_signal);
#endif
    for (i=1; i<argc; i++) {
        if (!strcmp(argv[i],"--connect")) {
            if (++i>=argc) { usage(); return 2; }
            target=argv[i];
        } else if (!strncmp(argv[i],"--connect=",10)) {
            target=argv[i]+10;
        } else { usage(); return 2; }
    }
    if (target) {
        if (!parse_connect_target(target,host,sizeof(host),port,sizeof(port))) {
            fprintf(stderr, "owc-exec: invalid --connect target (expected host:port)\n");
            usage();
            return 2;
        }
#ifdef _WIN32
        if (WSAStartup(MAKEWORD(2,2),&wsa)!=0) { fprintf(stderr,"owc-exec: WSAStartup failed\n"); return 1; }
#endif
        socket_handle=socket_connect(host,port);
        if (socket_handle<0 || !socket_streams(socket_handle,&input,&output)) {
            fprintf(stderr,"owc-exec: failed to connect to %s:%s\n",host,port);
#ifdef _WIN32
            (void)WSACleanup();
#endif
            return 1;
        }
        rpc.input=input; rpc.output=output;
    }
#ifdef _WIN32
    if (!target && (_setmode(_fileno(stdin),_O_BINARY)==-1 || _setmode(_fileno(stdout),_O_BINARY)==-1)) return 1;
#endif
    while(!rpc.shutting_down) {
        char *body=NULL; size_t length=0; int status=owc_rpc_read(&rpc,&body,&length);
        if(status==0) break;
        if(status<0) { fprintf(stderr,"owc-exec: invalid RPC frame\n"); free(body);
#ifndef _WIN32
            owc_platform_exec_terminate_all();
            owc_pty_terminate_all();
#endif
            return 2; }
        (void)owc_rpc_dispatch(&rpc,body,length); free(body);
    }
#ifndef _WIN32
    owc_platform_exec_terminate_all();
    owc_pty_terminate_all();
#endif
    owc_rpc_release_sessions();
    if (input) fclose(input);
    if (output) fclose(output);
#ifdef _WIN32
    if (target) (void)WSACleanup();
#endif
    return 0;
}
