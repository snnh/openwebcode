#include "path_policy.h"

#include <ctype.h>
#include <string.h>

static int same_char(char a, char b) {
#ifdef _WIN32
    if (a=='\\') a='/'; if (b=='\\') b='/';
    return tolower((unsigned char)a)==tolower((unsigned char)b);
#else
    return a==b;
#endif
}

int owc_path_is_within(const char *path, const char *root) {
    size_t i=0, root_length;
    if(!path || !root) return 0;
    root_length=strlen(root);
    while(root_length>1 && (root[root_length-1]=='/' || root[root_length-1]=='\\')) {
#ifdef _WIN32
        if(root_length==3 && root[1]==':') break;
#endif
        root_length--;
    }
    for(i=0;i<root_length;i++) if(!path[i] || !same_char(path[i],root[i])) return 0;
    if(root_length==1 && (root[0]=='/' || root[0]=='\\')) return path[0]=='/' || path[0]=='\\';
#ifdef _WIN32
    if(root_length==3 && root[1]==':' && (root[2]=='/' || root[2]=='\\')) return 1;
#endif
    return path[i]=='\0' || path[i]=='/' || path[i]=='\\';
}

int owc_path_policy_check(const owc_path_policy *policy, const char *path, owc_path_permission permission) {
    const char *const *roots; size_t count,i;
    if(!policy || !path) return 0;
    for(i=0;i<policy->deny_root_count;i++) if(owc_path_is_within(path,policy->deny_roots[i])) return 0;
    if(permission==OWC_PATH_WRITE) { roots=policy->write_roots; count=policy->write_root_count; }
    else { roots=policy->read_roots; count=policy->read_root_count; }
    for(i=0;i<count;i++) if(owc_path_is_within(path,roots[i])) return 1;
    return 0;
}
