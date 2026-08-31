#include "sandbox.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifdef _WIN32
#include <aclapi.h>

/* Same manual declaration as sandbox_win.c: userenv.h is not in every SDK. */
HRESULT WINAPI DeriveAppContainerSidFromAppContainerName(PCWSTR, PSID *);

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
        (void)fprintf(stderr, "ACL sandbox creation failed: %s\n", reason);
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

static int test_reparse_root_rejected(void) {
    wchar_t temp[MAX_PATH], root[MAX_PATH], target[MAX_PATH], link[MAX_PATH];
    char link_utf8[MAX_PATH * 3], session_id[64], reason[256];
    unsigned char *link_before = NULL, *link_after = NULL;
    unsigned char *target_before = NULL, *target_after = NULL;
    DWORD lb_size = 0, la_size = 0;
    DWORD tb_size = 0, ta_size = 0;
    int lb_protected = 0, la_protected = 0;
    int tb_protected = 0, ta_protected = 0;
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
    (void)snprintf(session_id, sizeof(session_id), "reparse-reject-%lu",
                   (unsigned long)GetCurrentProcessId());
    roots[0] = link_utf8;
    memset(&options, 0, sizeof(options));
    options.session_id = session_id;
    options.write_roots = roots;
    options.write_root_count = 1;
    /* A reparse-point write root is ambiguous with the fs layer (which
     * rejects it), so the grant must fail closed and leave both DACLs
     * untouched. */
    sandbox = owc_sandbox_create(&options, reason, sizeof(reason));
    if (sandbox) {
        (void)fprintf(stderr, "reparse-point write root was not rejected\n");
        result = 24;
        goto cleanup;
    }
    if (!strstr(reason, "reparse point")) {
        (void)fprintf(stderr, "reparse rejection reason is unclear: %s\n",
                      reason);
        result = 24;
        goto cleanup;
    }
    if (!capture_dacl_mode(link, 1, &link_after, &la_size, &la_protected) ||
        !capture_dacl(target, &target_after, &ta_size, &ta_protected) ||
        lb_size != la_size || lb_protected != la_protected ||
        memcmp(link_before, link_after, lb_size) != 0 ||
        tb_size != ta_size || tb_protected != ta_protected ||
        memcmp(target_before, target_after, tb_size) != 0) result = 26;
cleanup:
    owc_sandbox_destroy(sandbox);
    free(link_before); free(link_after);
    free(target_before); free(target_after);
    (void)RemoveDirectoryW(link);
    (void)RemoveDirectoryW(target);
    (void)RemoveDirectoryW(root);
    return result;
}

/* Returns 1 when the DACL of path could be read; *present tells whether any
 * ACE (allow or deny) references sid. */
static int dacl_has_sid_ace(const wchar_t *path, PSID sid, int *present) {
    PACL acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    DWORD error, index;
    *present = 0;
    error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                  DACL_SECURITY_INFORMATION, NULL, NULL,
                                  &acl, NULL, &descriptor);
    if (error != ERROR_SUCCESS || !acl) {
        if (descriptor) LocalFree(descriptor);
        return 0;
    }
    for (index = 0; index < acl->AceCount; ++index) {
        ACE_HEADER *header = NULL;
        PSID ace_sid = NULL;
        if (!GetAce(acl, index, (LPVOID *)&header) || !header) continue;
        if (header->AceType == ACCESS_ALLOWED_ACE_TYPE)
            ace_sid = (PSID)&((ACCESS_ALLOWED_ACE *)header)->SidStart;
        else if (header->AceType == ACCESS_DENIED_ACE_TYPE)
            ace_sid = (PSID)&((ACCESS_DENIED_ACE *)header)->SidStart;
        if (ace_sid && EqualSid(sid, ace_sid)) *present = 1;
    }
    LocalFree(descriptor);
    return 1;
}

static int test_deny_acl_restore(void) {
    wchar_t temp[MAX_PATH], root[MAX_PATH], denied[MAX_PATH], allowed[MAX_PATH];
    char root_utf8[MAX_PATH * 3], denied_utf8[MAX_PATH * 3];
    char allowed_utf8[MAX_PATH * 3];
    char missing_utf8[MAX_PATH * 3], session_id[64], reason[256];
    wchar_t profile_name[96];
    unsigned char *after = NULL;
    DWORD after_size = 0;
    int after_protected = 0;
    const char *roots[1], *denies[2];
    owc_sandbox_options options;
    owc_sandbox *sandbox = NULL;
    PSID sid = NULL;
    HRESULT hr;
    int present = 0;
    int result = 0;
    if (!GetTempPathW(ARRAYSIZE(temp), temp) ||
        !GetTempFileNameW(temp, L"owd", 0, root) ||
        !DeleteFileW(root) || !CreateDirectoryW(root, NULL)) return 40;
    if (swprintf_s(denied, ARRAYSIZE(denied), L"%ls\\denied.txt", root) < 0 ||
        swprintf_s(allowed, ARRAYSIZE(allowed), L"%ls\\allowed.txt", root) < 0) {
        result = 41;
        goto cleanup;
    }
    {
        HANDLE file = CreateFileW(denied, GENERIC_WRITE, 0, NULL,
                                  CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file == INVALID_HANDLE_VALUE) {
            result = 41;
            goto cleanup;
        }
        CloseHandle(file);
        file = CreateFileW(allowed, GENERIC_WRITE, 0, NULL,
                           CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file == INVALID_HANDLE_VALUE) {
            result = 41;
            goto cleanup;
        }
        CloseHandle(file);
    }
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, root, -1,
                             root_utf8, (int)sizeof(root_utf8), NULL, NULL) ||
        !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, denied, -1,
                             denied_utf8, (int)sizeof(denied_utf8), NULL, NULL) ||
        !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, allowed, -1,
                             allowed_utf8, (int)sizeof(allowed_utf8), NULL, NULL) ||
        !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS,
                             L"missing-deny-target.txt", -1,
                             missing_utf8, (int)sizeof(missing_utf8), NULL, NULL)) {
        result = 42;
        goto cleanup;
    }
    (void)snprintf(session_id, sizeof(session_id), "deny-acl-%lu",
                   (unsigned long)GetCurrentProcessId());
    roots[0] = root_utf8;
    denies[0] = denied_utf8;
    /* A deny path that does not exist must be skipped, not fail the grant. */
    denies[1] = missing_utf8;
    memset(&options, 0, sizeof(options));
    options.session_id = session_id;
    options.write_roots = roots;
    options.write_root_count = 1;
    options.deny_paths = denies;
    options.deny_count = 2;
    sandbox = owc_sandbox_create(&options, reason, sizeof(reason));
    if (!sandbox) {
        (void)fprintf(stderr, "deny ACL sandbox creation failed: %s\n", reason);
        result = 44;
        goto cleanup;
    }
    /* The sandbox profile SID is derived from the profile name. */
    if (swprintf_s(profile_name, ARRAYSIZE(profile_name), L"OpenWebCode.%hs",
                   session_id) < 0) {
        result = 45;
        goto cleanup;
    }
    hr = DeriveAppContainerSidFromAppContainerName(profile_name, &sid);
    if (FAILED(hr) || !sid) {
        result = 45;
        goto cleanup;
    }
    /* The deny path must carry no ACE for the package SID at all: the
       AppContainer package leg is allow-only, so the write-root grant's
       propagated allow must have been stripped. */
    if (!dacl_has_sid_ace(denied, sid, &present)) {
        result = 46;
        goto cleanup;
    }
    if (present) {
        (void)fprintf(stderr, "denied path DACL still references the sandbox SID\n");
        result = 47;
        goto cleanup;
    }
    /* Positive control: a sibling that is not a deny path keeps the
       propagated write-root grant (proves the strip is targeted, and that
       the grant itself worked). */
    if (!dacl_has_sid_ace(allowed, sid, &present)) {
        result = 46;
        goto cleanup;
    }
    if (!present) {
        (void)fprintf(stderr, "allowed sibling lost the sandbox SID grant\n");
        result = 47;
        goto cleanup;
    }
    owc_sandbox_destroy(sandbox);
    sandbox = NULL;
    /* Byte-level restore of the deny path itself is not achievable: the
       write-root grant's propagation rewrites the children's inherited ACEs
       at grant time already (creation-time and propagation-time inheritance
       differ on some machines), and that drift predates the strip's DACL
       snapshot.  What the restore must guarantee instead: inheritance
       protection is lifted again and no ACE for the command's SID remains.
       (The write root's own byte-exact restore is covered by
       test_acl_restore.) */
    if (!dacl_has_sid_ace(denied, sid, &present)) {
        result = 48;
        goto cleanup;
    }
    if (present) {
        (void)fprintf(stderr, "denied path keeps a sandbox SID ACE after destroy\n");
        result = 49;
        goto cleanup;
    }
    if (!capture_dacl(denied, &after, &after_size, &after_protected) ||
        after_protected) {
        (void)fprintf(stderr, "denied path DACL stayed protected after destroy\n");
        result = 49;
        goto cleanup;
    }
cleanup:
    owc_sandbox_destroy(sandbox);
    if (sid) FreeSid(sid);
    free(after);
    (void)DeleteFileW(allowed);
    (void)DeleteFileW(denied);
    (void)RemoveDirectoryW(root);
    return result;
}

/* Two concurrent commands strip the same deny path (parallel tool calls in
 * one workspace).  The first destroy must NOT write anything back - the
 * other command still holds the strip, and restoring + unprotecting would
 * re-inherit its allow ACE from the write root; the last destroy restores.
 * Regression test for the process-wide deny-strip registry. */
static int test_deny_acl_concurrent(void) {
    wchar_t temp[MAX_PATH], root[MAX_PATH], denied[MAX_PATH];
    char root_utf8[MAX_PATH * 3], denied_utf8[MAX_PATH * 3];
    char session_a[64], session_b[64], reason[256];
    wchar_t profile_a[96], profile_b[96];
    unsigned char *after = NULL;
    DWORD after_size = 0;
    int after_protected = 0;
    const char *roots[1], *denies[1];
    owc_sandbox_options options;
    owc_sandbox *sandbox_a = NULL, *sandbox_b = NULL;
    PSID sid_a = NULL, sid_b = NULL;
    HRESULT hr;
    int present = 0;
    int result = 0;
    if (!GetTempPathW(ARRAYSIZE(temp), temp) ||
        !GetTempFileNameW(temp, L"owc", 0, root) ||
        !DeleteFileW(root) || !CreateDirectoryW(root, NULL)) return 50;
    if (swprintf_s(denied, ARRAYSIZE(denied), L"%ls\\denied.txt", root) < 0) {
        result = 51;
        goto cleanup;
    }
    {
        HANDLE file = CreateFileW(denied, GENERIC_WRITE, 0, NULL,
                                  CREATE_NEW, FILE_ATTRIBUTE_NORMAL, NULL);
        if (file == INVALID_HANDLE_VALUE) {
            result = 51;
            goto cleanup;
        }
        CloseHandle(file);
    }
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, root, -1,
                             root_utf8, (int)sizeof(root_utf8), NULL, NULL) ||
        !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, denied, -1,
                             denied_utf8, (int)sizeof(denied_utf8), NULL, NULL)) {
        result = 52;
        goto cleanup;
    }
    (void)snprintf(session_a, sizeof(session_a), "deny-conc-a-%lu",
                   (unsigned long)GetCurrentProcessId());
    (void)snprintf(session_b, sizeof(session_b), "deny-conc-b-%lu",
                   (unsigned long)GetCurrentProcessId());
    if (swprintf_s(profile_a, ARRAYSIZE(profile_a), L"OpenWebCode.%hs", session_a) < 0 ||
        swprintf_s(profile_b, ARRAYSIZE(profile_b), L"OpenWebCode.%hs", session_b) < 0) {
        result = 53;
        goto cleanup;
    }
    hr = DeriveAppContainerSidFromAppContainerName(profile_a, &sid_a);
    if (FAILED(hr) || !sid_a) {
        result = 53;
        goto cleanup;
    }
    hr = DeriveAppContainerSidFromAppContainerName(profile_b, &sid_b);
    if (FAILED(hr) || !sid_b) {
        result = 53;
        goto cleanup;
    }
    roots[0] = root_utf8;
    denies[0] = denied_utf8;
    memset(&options, 0, sizeof(options));
    options.write_roots = roots;
    options.write_root_count = 1;
    options.deny_paths = denies;
    options.deny_count = 1;
    options.session_id = session_a;
    sandbox_a = owc_sandbox_create(&options, reason, sizeof(reason));
    if (!sandbox_a) {
        (void)fprintf(stderr, "concurrent deny sandbox A failed: %s\n", reason);
        result = 54;
        goto cleanup;
    }
    options.session_id = session_b;
    sandbox_b = owc_sandbox_create(&options, reason, sizeof(reason));
    if (!sandbox_b) {
        (void)fprintf(stderr, "concurrent deny sandbox B failed: %s\n", reason);
        result = 54;
        goto cleanup;
    }
    /* Both SIDs stripped while both commands live. */
    if (!dacl_has_sid_ace(denied, sid_a, &present) || present ||
        !dacl_has_sid_ace(denied, sid_b, &present) || present) {
        (void)fprintf(stderr, "concurrent deny path still carries a package SID\n");
        result = 55;
        goto cleanup;
    }
    /* The first destroy must defer the restore: still stripped, still
     * protected, and no SID resurrection. */
    owc_sandbox_destroy(sandbox_a);
    sandbox_a = NULL;
    if (!dacl_has_sid_ace(denied, sid_a, &present) || present ||
        !dacl_has_sid_ace(denied, sid_b, &present) || present) {
        (void)fprintf(stderr, "first destroy resurrected a package SID ACE\n");
        result = 56;
        goto cleanup;
    }
    if (!capture_dacl(denied, &after, &after_size, &after_protected) ||
        !after_protected) {
        (void)fprintf(stderr, "first destroy lifted deny-path protection early\n");
        result = 57;
        goto cleanup;
    }
    free(after);
    after = NULL;
    /* The last destroy restores: protection lifted, no package SID left. */
    owc_sandbox_destroy(sandbox_b);
    sandbox_b = NULL;
    if (!dacl_has_sid_ace(denied, sid_a, &present) || present ||
        !dacl_has_sid_ace(denied, sid_b, &present) || present) {
        (void)fprintf(stderr, "last destroy left a package SID ACE behind\n");
        result = 58;
        goto cleanup;
    }
    if (!capture_dacl(denied, &after, &after_size, &after_protected) ||
        after_protected) {
        (void)fprintf(stderr, "last destroy did not lift deny-path protection\n");
        result = 59;
        goto cleanup;
    }
cleanup:
    owc_sandbox_destroy(sandbox_a);
    owc_sandbox_destroy(sandbox_b);
    if (sid_a) FreeSid(sid_a);
    if (sid_b) FreeSid(sid_b);
    free(after);
    (void)DeleteFileW(denied);
    (void)RemoveDirectoryW(root);
    return result;
}
static int test_bind_acl_restore(void) {
    wchar_t temp[MAX_PATH], root[MAX_PATH], backing[MAX_PATH];
    char root_utf8[MAX_PATH * 3], backing_utf8[MAX_PATH * 3];
    char session_id[64], reason[256];
    unsigned char *before = NULL, *granted = NULL, *after = NULL;
    DWORD before_size = 0, granted_size = 0, after_size = 0;
    int before_protected = 0, granted_protected = 0, after_protected = 0;
    const char *roots[1], *backings[1];
    int read_only[1];
    owc_sandbox_options options;
    owc_sandbox *sandbox = NULL;
    int result = 0;
    if (!GetTempPathW(ARRAYSIZE(temp), temp) ||
        !GetTempFileNameW(temp, L"owb", 0, root) ||
        !DeleteFileW(root) || !CreateDirectoryW(root, NULL)) return 30;
    if (!GetTempFileNameW(temp, L"owk", 0, backing) ||
        !DeleteFileW(backing) || !CreateDirectoryW(backing, NULL)) {
        result = 31;
        goto cleanup;
    }
    if (!WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, root, -1,
                             root_utf8, (int)sizeof(root_utf8), NULL, NULL) ||
        !WideCharToMultiByte(CP_UTF8, WC_ERR_INVALID_CHARS, backing, -1,
                             backing_utf8, (int)sizeof(backing_utf8), NULL, NULL)) {
        result = 32;
        goto cleanup;
    }
    if (!capture_dacl(backing, &before, &before_size, &before_protected)) {
        result = 33;
        goto cleanup;
    }
    (void)snprintf(session_id, sizeof(session_id), "bind-acl-restore-%lu",
                   (unsigned long)GetCurrentProcessId());
    roots[0] = root_utf8;
    backings[0] = backing_utf8;
    read_only[0] = 0;
    memset(&options, 0, sizeof(options));
    options.session_id = session_id;
    options.write_roots = roots;
    options.write_root_count = 1;
    options.bind_backing = backings;
    options.bind_read_only = read_only;
    options.bind_count = 1;
    sandbox = owc_sandbox_create(&options, reason, sizeof(reason));
    if (!sandbox) {
        (void)fprintf(stderr, "bind ACL sandbox creation failed: %s\n", reason);
        result = 34;
        goto cleanup;
    }
    if (!capture_dacl(backing, &granted, &granted_size, &granted_protected) ||
        before_protected != granted_protected ||
        (before_size == granted_size &&
         memcmp(before, granted, before_size) == 0)) {
        result = 35;
        goto cleanup;
    }
    owc_sandbox_destroy(sandbox);
    sandbox = NULL;
    if (!capture_dacl(backing, &after, &after_size, &after_protected) ||
        before_size != after_size || before_protected != after_protected ||
        memcmp(before, after, before_size) != 0) result = 36;
cleanup:
    owc_sandbox_destroy(sandbox);
    free(before); free(granted); free(after);
    (void)RemoveDirectoryW(backing);
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
    if (status == OWC_SANDBOX_ENFORCED && strstr(reason, "verified") == NULL) return 4;
    if (status == OWC_SANDBOX_ADVISORY) {
        (void)fprintf(stderr, "Windows ACL sandbox tests skipped: %s\n", reason);
    } else {
        int acl_result = test_acl_restore();
        if (acl_result) {
            (void)fprintf(stderr, "ACL restore test failed: %d\n", acl_result);
            return acl_result;
        }
        {
            int reparse_result = test_reparse_root_rejected();
            if (reparse_result) {
                (void)fprintf(stderr, "reparse root rejection test failed: %d\n",
                              reparse_result);
                return reparse_result;
            }
        }
        {
            int deny_result = test_deny_acl_restore();
            if (deny_result) {
                (void)fprintf(stderr, "deny ACL restore test failed: %d\n",
                              deny_result);
                return deny_result;
            }
        }
        {
            int concurrent_result = test_deny_acl_concurrent();
            if (concurrent_result) {
                (void)fprintf(stderr, "deny ACL concurrency test failed: %d\n",
                              concurrent_result);
                return concurrent_result;
            }
        }
        {
            int bind_result = test_bind_acl_restore();
            if (bind_result) {
                (void)fprintf(stderr, "bind ACL restore test failed: %d\n",
                              bind_result);
                return bind_result;
            }
        }
    }
#else
    {
        /* The runtime exemption tables must keep system binaries, kernel
         * pseudo filesystems, scratch space, and device nodes reachable
         * under Landlock enforcement. */
        static const char *const required_read_exec[] = {
            "/usr", "/bin", "/lib", "/lib64", "/etc", "/proc", "/sys"
        };
        static const char *const required_full[] = {"/tmp", "/dev"};
        size_t i, j;
        for (i = 0; i < sizeof(required_read_exec) / sizeof(required_read_exec[0]); ++i) {
            for (j = 0; j < owc_landlock_read_exec_path_count; ++j)
                if (!strcmp(owc_landlock_read_exec_paths[j], required_read_exec[i])) break;
            if (j == owc_landlock_read_exec_path_count) return 5;
        }
        for (i = 0; i < sizeof(required_full) / sizeof(required_full[0]); ++i) {
            for (j = 0; j < owc_landlock_full_access_path_count; ++j)
                if (!strcmp(owc_landlock_full_access_paths[j], required_full[i])) break;
            if (j == owc_landlock_full_access_path_count) return 6;
        }
    }
#endif
    (void)printf("status=%s reason=%s\n", name, reason);
    return 0;
}
