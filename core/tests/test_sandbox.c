#include "sandbox.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <aclapi.h>

static int capture_dacl(const wchar_t *path, unsigned char **bytes,
                        DWORD *size, int *is_protected) {
    PACL acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    ACL_SIZE_INFORMATION info;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    DWORD error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                        DACL_SECURITY_INFORMATION, NULL, NULL,
                                        &acl, NULL, &descriptor);
    if (error != ERROR_SUCCESS || !acl ||
        !GetAclInformation(acl, &info, sizeof(info), AclSizeInformation)) {
        if (descriptor) LocalFree(descriptor);
        return 0;
    }
    *bytes = (unsigned char *)malloc(info.AclBytesInUse);
    if (!*bytes) {
        LocalFree(descriptor);
        return 0;
    }
    (void)memcpy(*bytes, acl, info.AclBytesInUse);
    *size = info.AclBytesInUse;
    *is_protected = GetSecurityDescriptorControl(descriptor, &control, &revision) &&
                    (control & SE_DACL_PROTECTED) != 0;
    LocalFree(descriptor);
    return 1;
}

static int test_acl_restore(void) {
    wchar_t temp[MAX_PATH], root[MAX_PATH];
    char root_utf8[MAX_PATH * 3], session_id[64], reason[256];
    unsigned char *before = NULL, *granted = NULL, *after = NULL;
    DWORD before_size = 0, granted_size = 0, after_size = 0;
    int before_protected = 0, granted_protected = 0, after_protected = 0;
    const char *roots[1];
    owc_sandbox_options options;
    owc_sandbox *sandbox = NULL;
    int result = 0;
    if (!GetTempPathW(ARRAYSIZE(temp), temp) ||
        !GetTempFileNameW(temp, L"owc", 0, root) ||
        !DeleteFileW(root) || !CreateDirectoryW(root, NULL)) return 10;
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, root, -1,
                             root_utf8, (int)sizeof(root_utf8), NULL, NULL)) {
        result = 11;
        goto cleanup;
    }
    if (!capture_dacl(root, &before, &before_size, &before_protected)) {
        result = 12;
        goto cleanup;
    }
    (void)snprintf(session_id, sizeof(session_id), "acl-restore-%lu",
                   (unsigned long)GetCurrentProcessId());
    roots[0] = root_utf8;
    memset(&options, 0, sizeof(options));
    options.session_id = session_id;
    options.write_roots = roots;
    options.write_root_count = 1;
    sandbox = owc_sandbox_create(&options, reason, sizeof(reason));
    if (!sandbox) {
        result = 13;
        goto cleanup;
    }
    if (!capture_dacl(root, &granted, &granted_size, &granted_protected) ||
        before_protected != granted_protected ||
        (before_size == granted_size &&
         memcmp(before, granted, before_size) == 0)) {
        result = 14;
        goto cleanup;
    }
    owc_sandbox_destroy(sandbox);
    sandbox = NULL;
    if (!capture_dacl(root, &after, &after_size, &after_protected) ||
        before_size != after_size || before_protected != after_protected ||
        memcmp(before, after, before_size) != 0) result = 15;
cleanup:
    owc_sandbox_destroy(sandbox);
    free(before); free(granted); free(after);
    (void)RemoveDirectoryW(root);
    return result;
}
#endif

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
    {
        int acl_result = test_acl_restore();
        if (acl_result) return acl_result;
    }
#endif
    (void)printf("status=%s reason=%s\n", name, reason);
    return 0;
}
