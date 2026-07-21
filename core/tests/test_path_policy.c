#include "path_policy.h"

#define CHECK(condition) do { if (!(condition)) return 1; } while (0)

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
    CHECK(owc_path_is_within("C:\\work\\src\\main.c","c:/work"));
    CHECK(owc_path_is_within("C:\\work\\src\\main.c","C:\\"));
    CHECK(!owc_path_is_within("C:\\worker\\main.c","C:\\work"));
    CHECK(owc_path_policy_check(&policy,"C:\\work\\src\\main.c",OWC_PATH_WRITE));
    CHECK(!owc_path_policy_check(&policy,"C:\\work\\README.md",OWC_PATH_WRITE));
    CHECK(!owc_path_policy_check(&policy,"C:\\work\\.secret\\key",OWC_PATH_READ));
#else
    CHECK(owc_path_is_within("/work/src/main.c","/work"));
    CHECK(owc_path_is_within("/work/src/main.c","/"));
    CHECK(!owc_path_is_within("/worker/main.c","/work"));
    CHECK(owc_path_policy_check(&policy,"/work/src/main.c",OWC_PATH_WRITE));
    CHECK(!owc_path_policy_check(&policy,"/work/README.md",OWC_PATH_WRITE));
    CHECK(!owc_path_policy_check(&policy,"/work/.secret/key",OWC_PATH_READ));
#endif
    return 0;
}
