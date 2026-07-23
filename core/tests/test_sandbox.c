#include "sandbox.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <aclapi.h>

static int capture_dacl_mode(const wchar_t *path, int open_reparse_point,
                             unsigned char **bytes, DWORD *size,
                             int *is_protected) {
    PACL acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    HANDLE handle = INVALID_HANDLE_VALUE;
    ACL_SIZE_INFORMATION info;
    SECURITY_DESCRIPTOR_CONTROL control = 0;
    DWORD revision = 0;
    DWORD error;
    if (open_reparse_point) {
        handle = CreateFileW(path, READ_CONTROL,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             NULL, OPEN_EXISTING,
                             FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT,
                             NULL);
        error = handle == INVALID_HANDLE_VALUE ? GetLastError() :
            GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            NULL, NULL, &acl, NULL, &descriptor);
    } else {
        error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                      DACL_SECURITY_INFORMATION, NULL, NULL,
                                      &acl, NULL, &descriptor);
    }
    if (error != ERROR_SUCCESS || !acl ||
        !GetAclInformation(acl, &info, sizeof(info), AclSizeInformation)) {
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        if (descriptor) LocalFree(descriptor);
        return 0;
    }
    *bytes = (unsigned char *)malloc(info.AclBytesInUse);
    if (!*bytes) {
        if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
        LocalFree(descriptor);
        return 0;
    }
    (void)memcpy(*bytes, acl, info.AclBytesInUse);
    *size = info.AclBytesInUse;
    *is_protected = GetSecurityDescriptorControl(descriptor, &control, &revision) &&
                    (control & SE_DACL_PROTECTED) != 0;
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    LocalFree(descriptor);
    return 1;
}

static int capture_dacl(const wchar_t *path, unsigned char **bytes,
                        DWORD *size, int *is_protected) {
    return capture_dacl_mode(path, 0, bytes, size, is_protected);
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

static int test_reparse_acl_restore(void) {
    wchar_t temp[MAX_PATH], root[MAX_PATH], target[MAX_PATH], link[MAX_PATH];
    char link_utf8[MAX_PATH * 3], session_id[64], reason[256];
    unsigned char *link_before = NULL, *link_granted = NULL, *link_after = NULL;
    unsigned char *target_before = NULL, *target_granted = NULL, *target_after = NULL;
    DWORD lb_size = 0, lg_size = 0, la_size = 0;
    DWORD tb_size = 0, tg_size = 0, ta_size = 0;
    int lb_protected = 0, lg_protected = 0, la_protected = 0;
    int tb_protected = 0, tg_protected = 0, ta_protected = 0;
    const char *roots[1];
    owc_sandbox_options options;
    owc_sandbox *sandbox = NULL;
    int result = 0;
    DWORD symlink_error;
    if (!GetTempPathW(ARRAYSIZE(temp), temp) ||
        !GetTempFileNameW(temp, L"owr", 0, root) ||
        !DeleteFileW(root) || !CreateDirectoryW(root, NULL)) return 20;
    if (swprintf_s(target, ARRAYSIZE(target), L"%ls\\target", root) < 0 ||
        swprintf_s(link, ARRAYSIZE(link), L"%ls\\link", root) < 0 ||
        !CreateDirectoryW(target, NULL)) {
        result = 21;
        goto cleanup;
    }
    if (!CreateSymbolicLinkW(link, target,
                             SYMBOLIC_LINK_FLAG_DIRECTORY |
                             SYMBOLIC_LINK_FLAG_ALLOW_UNPRIVILEGED_CREATE)) {
        symlink_error = GetLastError();
        if (symlink_error == ERROR_PRIVILEGE_NOT_HELD ||
            symlink_error == ERROR_ACCESS_DENIED ||
            symlink_error == ERROR_INVALID_PARAMETER ||
            symlink_error == ERROR_INVALID_FUNCTION ||
            symlink_error == ERROR_NOT_SUPPORTED) {
            (void)fprintf(stderr,
                          "reparse ACL test skipped: symbolic links unavailable "
                          "(error=%lu)\n",
                          (unsigned long)symlink_error);
            goto cleanup;
        }
        (void)fprintf(stderr,
                      "reparse ACL test could not create symbolic link "
                      "(error=%lu)\n",
                      (unsigned long)symlink_error);
        result = 22;
        goto cleanup;
    }
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, link, -1,
                             link_utf8, (int)sizeof(link_utf8), NULL, NULL) ||
        !capture_dacl_mode(link, 1, &link_before, &lb_size, &lb_protected) ||
        !capture_dacl(target, &target_before, &tb_size, &tb_protected)) {
        result = 23;
        goto cleanup;
    }
    (void)snprintf(session_id, sizeof(session_id), "reparse-restore-%lu",
                   (unsigned long)GetCurrentProcessId());
    roots[0] = link_utf8;
    memset(&options, 0, sizeof(options));
    options.session_id = session_id;
    options.write_roots = roots;
    options.write_root_count = 1;
    sandbox = owc_sandbox_create(&options, reason, sizeof(reason));
    if (!sandbox) {
        (void)fprintf(stderr,
                      "reparse ACL sandbox creation failed: %s\n", reason);
        result = 24;
        goto cleanup;
    }
    if (!capture_dacl_mode(link, 1, &link_granted, &lg_size, &lg_protected) ||
        !capture_dacl(target, &target_granted, &tg_size, &tg_protected) ||
        (lb_size == lg_size && memcmp(link_before, link_granted, lb_size) == 0) ||
        (tb_size == tg_size && memcmp(target_before, target_granted, tb_size) == 0)) {
        result = 25;
        goto cleanup;
    }
    owc_sandbox_destroy(sandbox);
    sandbox = NULL;
    if (!capture_dacl_mode(link, 1, &link_after, &la_size, &la_protected) ||
        !capture_dacl(target, &target_after, &ta_size, &ta_protected) ||
        lb_size != la_size || lb_protected != la_protected ||
        memcmp(link_before, link_after, lb_size) != 0 ||
        tb_size != ta_size || tb_protected != ta_protected ||
        memcmp(target_before, target_after, tb_size) != 0) result = 26;
cleanup:
    owc_sandbox_destroy(sandbox);
    free(link_before); free(link_granted); free(link_after);
    free(target_before); free(target_granted); free(target_after);
    (void)RemoveDirectoryW(link);
    (void)RemoveDirectoryW(target);
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
        if (acl_result) {
            (void)fprintf(stderr, "ACL restore test failed: %d\n", acl_result);
            return acl_result;
        }
    }
    {
        int reparse_result = test_reparse_acl_restore();
        if (reparse_result) {
            (void)fprintf(stderr, "reparse ACL restore test failed: %d\n",
                          reparse_result);
            return reparse_result;
        }
    }
#endif
    (void)printf("status=%s reason=%s\n", name, reason);
    return 0;
}
