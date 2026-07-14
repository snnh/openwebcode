#include "path_policy.h"

#include <assert.h>

int main(void) {
#ifdef _WIN32
    const char *read_roots[]={"C:\\work"};
    const char *write_roots[]={"C:\\work\\src"};
    const char *deny_roots[]={"C:\\work\\.secret"};
#else
    const char *read_roots[]={"/work"};
    const char *write_roots[]={"/work/src"};
    const char *deny_roots[]={"/work/.secret"};
#endif
    owc_path_policy policy={read_roots,1,write_roots,1,deny_roots,1};
#ifdef _WIN32
    assert(owc_path_is_within("C:\\work\\src\\main.c","c:/work"));
    assert(owc_path_is_within("C:\\work\\src\\main.c","C:\\"));
    assert(!owc_path_is_within("C:\\worker\\main.c","C:\\work"));
    assert(owc_path_policy_check(&policy,"C:\\work\\src\\main.c",OWC_PATH_WRITE));
    assert(!owc_path_policy_check(&policy,"C:\\work\\README.md",OWC_PATH_WRITE));
    assert(!owc_path_policy_check(&policy,"C:\\work\\.secret\\key",OWC_PATH_READ));
#else
    assert(owc_path_is_within("/work/src/main.c","/work"));
    assert(owc_path_is_within("/work/src/main.c","/"));
    assert(!owc_path_is_within("/worker/main.c","/work"));
    assert(owc_path_policy_check(&policy,"/work/src/main.c",OWC_PATH_WRITE));
    assert(!owc_path_policy_check(&policy,"/work/README.md",OWC_PATH_WRITE));
    assert(!owc_path_policy_check(&policy,"/work/.secret/key",OWC_PATH_READ));
#endif
    return 0;
}
