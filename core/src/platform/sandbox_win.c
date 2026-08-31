#include "sandbox.h"

#include <windows.h>
#include <aclapi.h>
#include <sddl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

HRESULT WINAPI CreateAppContainerProfile(PCWSTR, PCWSTR, PCWSTR,
                                         PSID_AND_ATTRIBUTES, DWORD, PSID *);
HRESULT WINAPI DeleteAppContainerProfile(PCWSTR);
HRESULT WINAPI DeriveAppContainerSidFromAppContainerName(PCWSTR, PSID *);

struct owc_acl_grant {
    wchar_t *path;
    int access_kind;
    /* OWC_ACL_DENY_PATH: DACL bytes saved before the strip so destroy can
       write them back (minus this command's own SID) with UNPROTECTED_DACL,
       resuming inheritance byte for byte. */
    unsigned char *dacl;
    DWORD dacl_size;
};

enum owc_acl_access_kind {
    OWC_ACL_NAMED_PATH = 0,
    OWC_ACL_REPARSE_POINT = 1,
    OWC_ACL_REPARSE_TARGET = 2,
    OWC_ACL_ANCESTOR = 3,
    OWC_ACL_DENY_PATH = 4
};

struct owc_sandbox {
    PSID appcontainer_sid;
    PSID capability_sids[2];
    SID_AND_ATTRIBUTES capabilities[2];
    SECURITY_CAPABILITIES security_capabilities;
    wchar_t *profile_name;
    struct owc_acl_grant *grants;
    size_t grant_count;
    int profile_created;
    int attribute_applied;
    int shared_profile;
    owc_sandbox_status status;
};

static void set_reason(char *reason, size_t size, const char *text) {
    if (!reason || size == 0) return;
    (void)snprintf(reason, size, "%s", text ? text : "");
}

static wchar_t *utf8_to_wide(const char *text) {
    int length;
    wchar_t *wide;
    if (!text) return NULL;
    length = MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, NULL, 0);
    if (length <= 0) return NULL;
    wide = (wchar_t *)calloc((size_t)length, sizeof(*wide));
    if (!wide) return NULL;
    if (!MultiByteToWideChar(CP_UTF8, MB_ERR_INVALID_CHARS, text, -1, wide, length)) {
        free(wide);
        return NULL;
    }
    return wide;
}

/* A DACL edit is read-modify-write.  Two write modes on purpose:
 * write roots use the *Named* Win32 APIs, which physically propagate
 * inheritable ACEs to existing descendants (access checks do not
 * apply a parent's new ACE retroactively, so the workspace tree is
 * only accessible through this propagation); ancestor traverse
 * grants use NtSetSecurityObject, which touches only the object
 * itself, because propagating into an ancestor's tree can rewrite
 * millions of ACLs.  Two commands on the same write root in this one
 * core process can otherwise interleave and have one grant overwrite
 * the other's.  Serialize the RMW per process so concurrent
 * grants/revokes never clobber. */
static INIT_ONCE acl_once = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION acl_mutex;
static LONG (NTAPI *nt_set_security_object)(HANDLE, SECURITY_INFORMATION,
                                            PSECURITY_DESCRIPTOR);
static BOOL CALLBACK acl_mutex_init(PINIT_ONCE once, PVOID param, PVOID *context) {
    HMODULE ntdll;
    (void)once; (void)param; (void)context;
    InitializeCriticalSection(&acl_mutex);
    ntdll = GetModuleHandleW(L"ntdll.dll");
    if (ntdll)
        nt_set_security_object = (LONG (NTAPI *)(HANDLE, SECURITY_INFORMATION,
                                                 PSECURITY_DESCRIPTOR))
            GetProcAddress(ntdll, "NtSetSecurityObject");
    return TRUE;
}

static DWORD change_root_access(const wchar_t *path, PSID sid, ACCESS_MODE mode,
                                DWORD permissions, DWORD inheritance,
                                int access_kind) {
    PACL old_acl = NULL, new_acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    HANDLE handle = INVALID_HANDLE_VALUE;
    EXPLICIT_ACCESSW access;
    DWORD error;
    (void)InitOnceExecuteOnce(&acl_once, acl_mutex_init, NULL, NULL);
    EnterCriticalSection(&acl_mutex);
    if (access_kind != OWC_ACL_NAMED_PATH) {
        DWORD flags = FILE_FLAG_BACKUP_SEMANTICS;
        if (access_kind == OWC_ACL_REPARSE_POINT)
            flags |= FILE_FLAG_OPEN_REPARSE_POINT;
        handle = CreateFileW(path, READ_CONTROL | WRITE_DAC,
                             FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                             NULL, OPEN_EXISTING, flags, NULL);
        error = handle == INVALID_HANDLE_VALUE ? GetLastError() :
            GetSecurityInfo(handle, SE_FILE_OBJECT, DACL_SECURITY_INFORMATION,
                            NULL, NULL, &old_acl, NULL, &descriptor);
    } else {
        error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                      DACL_SECURITY_INFORMATION, NULL, NULL,
                                      &old_acl, NULL, &descriptor);
    }
    if (error == ERROR_SUCCESS) {
        memset(&access, 0, sizeof(access));
        access.grfAccessPermissions = permissions;
        access.grfAccessMode = mode;
        access.grfInheritance = inheritance;
        access.Trustee.TrusteeForm = TRUSTEE_IS_SID;
        access.Trustee.TrusteeType = TRUSTEE_IS_USER;
        access.Trustee.ptstrName = (LPWSTR)sid;
        error = SetEntriesInAclW(1, &access, old_acl, &new_acl);
        if (error == ERROR_SUCCESS) {
            if (access_kind == OWC_ACL_NAMED_PATH) {
                error = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                              DACL_SECURITY_INFORMATION,
                                              NULL, NULL, new_acl, NULL);
            } else if (nt_set_security_object) {
                SECURITY_DESCRIPTOR replacement;
                LONG status;
                InitializeSecurityDescriptor(&replacement, SECURITY_DESCRIPTOR_REVISION);
                SetSecurityDescriptorDacl(&replacement, TRUE, new_acl, FALSE);
                status = nt_set_security_object(handle, DACL_SECURITY_INFORMATION,
                                                &replacement);
                error = status >= 0 ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
            } else {
                error = SetSecurityInfo(handle, SE_FILE_OBJECT,
                                        DACL_SECURITY_INFORMATION,
                                        NULL, NULL, new_acl, NULL);
            }
        }
    }
    LeaveCriticalSection(&acl_mutex);
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    if (new_acl) LocalFree(new_acl);
    if (descriptor) LocalFree(descriptor);
    return error;
}

/* Reverse of the deny-path strip: write the saved pre-strip DACL back with
 * the SE_DACL_PROTECTED flag cleared.  This goes through NtSetSecurityObject
 * on purpose (the same no-propagation path as the ancestor grants): the
 * Named-API equivalent (UNPROTECTED_DACL_SECURITY_INFORMATION) recomputes
 * inherited ACEs from the parent, and that recomputation is not guaranteed
 * to reproduce the object's creation-time DACL byte for byte.
 * The saved bytes still carry the package-SID ACEs of every command that
 * stripped this path (the first save happens after that command's
 * write-root grant propagated its SID), so every registered SID is
 * filtered out.  Best effort like every revoke: a deny path deleted in the
 * meantime cannot be restored. */
static DWORD restore_denied_dacl(const wchar_t *path, const unsigned char *dacl,
                                 DWORD dacl_size, PSID *sids, size_t sid_count) {
    ACL_SIZE_INFORMATION info;
    PACL new_acl = NULL;
    SECURITY_DESCRIPTOR replacement;
    HANDLE handle = INVALID_HANDLE_VALUE;
    LONG status;
    DWORD error, i;
    if (!dacl || dacl_size < sizeof(ACL)) return ERROR_INVALID_DATA;
    (void)InitOnceExecuteOnce(&acl_once, acl_mutex_init, NULL, NULL);
    EnterCriticalSection(&acl_mutex);
    error = ERROR_SUCCESS;
    if (!GetAclInformation((PACL)dacl, &info, sizeof(info), AclSizeInformation)) {
        error = GetLastError();
        goto done;
    }
    new_acl = (PACL)LocalAlloc(LPTR, info.AclBytesInUse + sizeof(ACL));
    if (!new_acl ||
        !InitializeAcl(new_acl, info.AclBytesInUse + sizeof(ACL), ACL_REVISION)) {
        error = new_acl ? GetLastError() : ERROR_OUTOFMEMORY;
        goto done;
    }
    for (i = 0; i < ((PACL)dacl)->AceCount; ++i) {
        ACE_HEADER *ace = NULL;
        PSID ace_sid = NULL;
        if (!GetAce((PACL)dacl, i, (LPVOID *)&ace) || !ace) continue;
        if (ace->AceType == ACCESS_ALLOWED_ACE_TYPE)
            ace_sid = (PSID)&((ACCESS_ALLOWED_ACE *)ace)->SidStart;
        else if (ace->AceType == ACCESS_DENIED_ACE_TYPE)
            ace_sid = (PSID)&((ACCESS_DENIED_ACE *)ace)->SidStart;
        if (ace_sid) {
            size_t j;
            for (j = 0; j < sid_count; ++j)
                if (EqualSid(ace_sid, sids[j])) break;
            if (j < sid_count) continue;
        }
        if (!AddAce(new_acl, ACL_REVISION, MAXDWORD, ace, ace->AceSize)) {
            error = GetLastError();
            goto done;
        }
    }
    handle = CreateFileW(path, READ_CONTROL | WRITE_DAC,
                         FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE,
                         NULL, OPEN_EXISTING, FILE_FLAG_BACKUP_SEMANTICS, NULL);
    if (handle == INVALID_HANDLE_VALUE) {
        error = GetLastError();
        goto done;
    }
    if (!nt_set_security_object) {
        error = ERROR_PROC_NOT_FOUND;
        goto done;
    }
    InitializeSecurityDescriptor(&replacement, SECURITY_DESCRIPTOR_REVISION);
    /* SE_DACL_PRESENT set, SE_DACL_PROTECTED clear: protection is lifted and
       the DACL is written verbatim. */
    SetSecurityDescriptorDacl(&replacement, TRUE, new_acl, FALSE);
    status = nt_set_security_object(handle, DACL_SECURITY_INFORMATION,
                                    &replacement);
    error = status >= 0 ? ERROR_SUCCESS : ERROR_ACCESS_DENIED;
done:
    LeaveCriticalSection(&acl_mutex);
    if (handle != INVALID_HANDLE_VALUE) CloseHandle(handle);
    if (new_acl) LocalFree(new_acl);
    return error;
}

static DWORD strip_sid_from_dacl(const wchar_t *path, PSID sid, int protect,
                                 unsigned char **saved, DWORD *saved_size);

/* Concurrent commands in this one core process can strip the same deny path
 * (parallel tool calls share the workspace).  A per-command restore writing
 * its own snapshot back verbatim would clobber the other command's strip
 * and - once protection is lifted - re-inherit that command's allow ACE
 * from the write root, silently reopening the hole while the other command
 * still runs.  Deny paths are therefore tracked in a process-wide registry:
 * the first stripper saves the pre-strip DACL, later strippers only remove
 * their own SID, and the snapshot goes back (minus every registered SID,
 * protection lifted) only when the last holder is destroyed.  All registry
 * operations run under acl_mutex; CRITICAL_SECTION is recursive, so the
 * strip/restore helpers keep taking it internally. */
struct deny_strip_record {
    wchar_t *path;
    unsigned char *dacl;
    DWORD dacl_size;
    PSID *sids;
    size_t sid_count;
    size_t active;
};
static struct deny_strip_record *deny_strips;
static size_t deny_strip_count;

/* acl_mutex must be held. */
static struct deny_strip_record *deny_strip_find(const wchar_t *path) {
    size_t i;
    for (i = 0; i < deny_strip_count; ++i)
        if (!_wcsicmp(deny_strips[i].path, path)) return &deny_strips[i];
    return NULL;
}

/* acl_mutex must be held. */
static int deny_strip_add_sid(struct deny_strip_record *record, PSID sid) {
    DWORD length = GetLengthSid(sid);
    PSID copy = (PSID)malloc(length);
    PSID *grown;
    if (!copy) return 0;
    (void)memcpy(copy, sid, length);
    grown = (PSID *)realloc(record->sids, (record->sid_count + 1) * sizeof(*grown));
    if (!grown) {
        free(copy);
        return 0;
    }
    record->sids = grown;
    record->sids[record->sid_count++] = copy;
    return 1;
}

/* acl_mutex must be held.  Registers a fresh record, taking ownership of
 * the saved DACL bytes only on success. */
static int deny_strip_register(const wchar_t *path, unsigned char *saved,
                               DWORD saved_size, PSID sid) {
    struct deny_strip_record *grown;
    struct deny_strip_record *record;
    size_t length = wcslen(path) + 1;
    wchar_t *copy = (wchar_t *)malloc(length * sizeof(*copy));
    if (!copy) return 0;
    (void)memcpy(copy, path, length * sizeof(*copy));
    grown = (struct deny_strip_record *)realloc(
        deny_strips, (deny_strip_count + 1) * sizeof(*grown));
    if (!grown) {
        free(copy);
        return 0;
    }
    deny_strips = grown;
    record = &deny_strips[deny_strip_count];
    memset(record, 0, sizeof(*record));
    record->path = copy;
    record->dacl = saved;
    record->dacl_size = saved_size;
    record->active = 1;
    if (!deny_strip_add_sid(record, sid)) {
        free(record->path);
        return 0;
    }
    deny_strip_count++;
    return 1;
}

/* acl_mutex must be held. */
static DWORD deny_strip_acquire(const wchar_t *path, PSID sid) {
    struct deny_strip_record *record = deny_strip_find(path);
    DWORD error;
    unsigned char *saved = NULL;
    DWORD saved_size = 0;
    if (record) {
        /* Already stripped and protected by a live command; only this
         * command's own propagated allow ACE needs removing. */
        error = strip_sid_from_dacl(path, sid, 1, NULL, NULL);
        if (error != ERROR_SUCCESS) return error;
        if (!deny_strip_add_sid(record, sid)) return ERROR_OUTOFMEMORY;
        record->active++;
        return ERROR_SUCCESS;
    }
    error = strip_sid_from_dacl(path, sid, 1, &saved, &saved_size);
    if (error != ERROR_SUCCESS || !saved) {
        /* saved == NULL: nothing carried this SID (for example the deny
         * path sits outside the write roots), so nothing was written and
         * nothing needs restoring. */
        free(saved);
        return error;
    }
    if (!deny_strip_register(path, saved, saved_size, sid)) {
        free(saved);
        return ERROR_OUTOFMEMORY;
    }
    return ERROR_SUCCESS;
}

/* acl_mutex must be held. */
static void deny_strip_release(const wchar_t *path) {
    struct deny_strip_record *record = deny_strip_find(path);
    size_t i;
    if (!record || record->active == 0) return;
    if (--record->active > 0) return;
    /* Last holder: write the pre-strip DACL back minus every registered
     * package SID and lift the inheritance protection. */
    (void)restore_denied_dacl(record->path, record->dacl, record->dacl_size,
                              record->sids, record->sid_count);
    for (i = 0; i < record->sid_count; ++i) free(record->sids[i]);
    free(record->sids);
    free(record->path);
    free(record->dacl);
    i = (size_t)(record - deny_strips);
    if (i != deny_strip_count - 1)
        deny_strips[i] = deny_strips[deny_strip_count - 1];
    deny_strip_count--;
}

static void release_deny_strip_grant(const wchar_t *path) {
    (void)InitOnceExecuteOnce(&acl_once, acl_mutex_init, NULL, NULL);
    EnterCriticalSection(&acl_mutex);
    deny_strip_release(path);
    LeaveCriticalSection(&acl_mutex);
}

/* Cleanup of a plain grant revokes only the command's own SID ACE; it never
 * rewrites the surrounding DACL, so concurrent commands on the same write
 * root cannot strip one another's grant or resurrect a finished command's
 * ACE.  Deny paths go through the shared registry instead: the pre-strip
 * snapshot is written back only once the last command holding a strip on
 * that path exits, so a finishing command cannot reopen another command's
 * denied file. */
static DWORD restore_grant(const struct owc_acl_grant *grant, PSID sid) {
    if (grant->access_kind == OWC_ACL_DENY_PATH) {
        release_deny_strip_grant(grant->path);
        return ERROR_SUCCESS;
    }
    return change_root_access(grant->path, sid, REVOKE_ACCESS, 0,
                              NO_INHERITANCE, grant->access_kind);
}

static int remember_grant(owc_sandbox *sandbox, wchar_t *path,
                          int access_kind, unsigned char *dacl,
                          DWORD dacl_size) {
    struct owc_acl_grant *grown = (struct owc_acl_grant *)realloc(
        sandbox->grants, (sandbox->grant_count + 1) * sizeof(*grown));
    if (!grown) return 0;
    sandbox->grants = grown;
    sandbox->grants[sandbox->grant_count].path = path;
    sandbox->grants[sandbox->grant_count].access_kind = access_kind;
    sandbox->grants[sandbox->grant_count].dacl = dacl;
    sandbox->grants[sandbox->grant_count].dacl_size = dacl_size;
    sandbox->grant_count++;
    return 1;
}

/* Add a command-unique SID ACE without snapshotting the entire DACL. Cleanup
 * revokes only this SID, so concurrent commands on the same write root cannot
 * overwrite one another's ACL state or resurrect a finished command's ACE.
 * Inheritance is taken as a parameter so the same primitive serves traverse-
 * only ancestor grants (NO_INHERITANCE) and write-root grants that must let
 * newly created files inherit access (SUB_CONTAINERS_AND_OBJECTS_INHERIT). */
static int grant_temporary(owc_sandbox *sandbox, const wchar_t *path,
                           DWORD permissions, DWORD inheritance,
                           int access_kind) {
    size_t length = wcslen(path) + 1;
    wchar_t *copy = (wchar_t *)malloc(length * sizeof(*copy));
    if (!copy) return 0;
    (void)memcpy(copy, path, length * sizeof(*copy));
    if (change_root_access(copy, sandbox->appcontainer_sid, GRANT_ACCESS,
                           permissions, inheritance, access_kind) != ERROR_SUCCESS ||
        !remember_grant(sandbox, copy, access_kind, NULL, 0)) {
        (void)change_root_access(copy, sandbox->appcontainer_sid, REVOKE_ACCESS,
                                 0, inheritance, access_kind);
        free(copy);
        return 0;
    }
    return 1;
}

#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
static int grant_ancestor_traverse(owc_sandbox *sandbox, const char *root) {
    wchar_t *path = utf8_to_wide(root);
    size_t length;
    int ok = 1;
    if (!path) return 0;
    length = wcslen(path);
    while (length > 3 && (path[length - 1] == L'\\' || path[length - 1] == L'/'))
        path[--length] = L'\0';
    for (;;) {
        wchar_t *slash = wcsrchr(path, L'\\');
        wchar_t *forward = wcsrchr(path, L'/');
        if (!slash || (forward && forward > slash)) slash = forward;
        if (!slash) break;
        if (slash == path + 2 && path[1] == L':') {
            path[3] = L'\0';
            ok = grant_temporary(sandbox, path, FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                 NO_INHERITANCE, OWC_ACL_ANCESTOR);
            break;
        }
        *slash = L'\0';
        if (!path[0] || !grant_temporary(sandbox, path,
                                         FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                         NO_INHERITANCE, OWC_ACL_ANCESTOR)) {
            ok = 0;
            break;
        }
    }
    free(path);
    return ok;
}
#endif

/* GetVolumeNameForVolumeMountPointW only accepts a drive root, a volume
 * GUID path, or an actual mounted folder.  Since callers reach this helper
 * only after observing a reparse point, TRUE distinguishes a volume mount
 * root (the Named ACL APIs land on the same tree the fs layer resolves it
 * to) from a junction/symlink, which must be refused as a write root. */
static int is_volume_mount_point(const wchar_t *path) {
    wchar_t *root;
    wchar_t volume_name[64];
    size_t length = wcslen(path);
    int mounted;
    root = (wchar_t *)malloc((length + 2) * sizeof(*root));
    if (!root) return 0;
    (void)memcpy(root, path, (length + 1) * sizeof(*root));
    if (length && root[length - 1] != L'\\' && root[length - 1] != L'/') {
        root[length++] = L'\\';
        root[length] = L'\0';
    }
    mounted = GetVolumeNameForVolumeMountPointW(root, volume_name,
                                                (DWORD)ARRAYSIZE(volume_name)) != 0;
    free(root);
    return mounted;
}

static int grant_write_roots(owc_sandbox *sandbox,
                             const owc_sandbox_options *options,
                             char *reason, size_t reason_size) {
    size_t i;
    for (i = 0; i < options->write_root_count; ++i) {
        wchar_t *path = utf8_to_wide(options->write_roots[i]);
        DWORD attributes;
        if (!path) {
            set_reason(reason, reason_size, "writeRoot is not valid UTF-8");
            return 0;
        }
        /* A junction/symlink write root is ambiguous: the fs layer refuses
           it (canonical_root) while an ACL grant here would silently land on
           the target tree, so the same configuration would have two
           different meanings.  Fail closed and point at the real path; a
           volume mount root stays allowed because both layers resolve it to
           the same tree. */
        attributes = GetFileAttributesW(path);
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            !is_volume_mount_point(path)) {
            free(path);
            set_reason(reason, reason_size,
                       "writeRoot must not be a reparse point (junction/symlink); use the real path");
            return 0;
        }
        if (!grant_temporary(sandbox, path,
                             FILE_GENERIC_READ | FILE_GENERIC_WRITE |
                                 FILE_GENERIC_EXECUTE | DELETE,
                             SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                             OWC_ACL_NAMED_PATH)) {
            free(path);
            set_reason(reason, reason_size, "writeRoot ACL grant failed");
            return 0;
        }
        free(path);
    }
    /* The ACL unit-test target exercises write-root grant/cleanup without
     * editing the test runner's ancestor ACLs. */
#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
    /* Best-effort on every ancestor: a non-elevated core cannot edit DACLs
       it does not own (drive roots), and the ancestor may already be
       traversable via an existing ACE.  Grant where possible so shells that
       stat every path component (pwsh Set-Location) work on user-owned
       layouts; the write-root grant above remains the enforced boundary. */
    for (i = 0; i < options->write_root_count; ++i)
        (void)grant_ancestor_traverse(sandbox, options->write_roots[i]);
#endif
    return 1;
}

static void revoke_write_roots(owc_sandbox *sandbox) {
    size_t i = sandbox->grant_count;
    /* Two passes on purpose: deny-path restores write the saved DACL back
       verbatim, and they must run AFTER the write-root revoke - the root
       revoke's Named-API propagation recomputes inherited ACEs on every
       unprotected child, which would otherwise rewrite the just-restored
       deny path again (creation-time and propagation-time inheritance are
       not byte-identical on every machine). */
    while (i > 0) {
        --i;
        if (sandbox->grants[i].access_kind == OWC_ACL_DENY_PATH) continue;
        (void)restore_grant(&sandbox->grants[i], sandbox->appcontainer_sid);
    }
    for (i = 0; i < sandbox->grant_count; ++i)
        if (sandbox->grants[i].access_kind == OWC_ACL_DENY_PATH)
            (void)restore_grant(&sandbox->grants[i], sandbox->appcontainer_sid);
    for (i = 0; i < sandbox->grant_count; ++i) {
        free(sandbox->grants[i].path);
        free(sandbox->grants[i].dacl);
    }
    free(sandbox->grants);
}

/* Bind Link backing directories sit outside the write roots, so a sandboxed
 * process reaching them through the virtPath needs its own grant on the
 * backing tree.  Same mechanics as the write-root grants (recorded and
 * revoked symmetrically by revoke_write_roots, reparse points handled on
 * both the point and its target); read-only links get the
 * read/traverse/execute tier, writable links the write-root tier. */
static int grant_bind_backings(owc_sandbox *sandbox,
                               const owc_sandbox_options *options,
                               char *reason, size_t reason_size) {
    size_t i;
    for (i = 0; i < options->bind_count; ++i) {
        wchar_t *path = utf8_to_wide(options->bind_backing[i]);
        DWORD attributes;
        int read_only = options->bind_read_only ? options->bind_read_only[i] : 0;
        if (!path) {
            set_reason(reason, reason_size, "bind backing path is not valid UTF-8");
            return 0;
        }
        attributes = GetFileAttributesW(path);
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT) &&
            !grant_temporary(sandbox, path,
                             FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                             NO_INHERITANCE, OWC_ACL_REPARSE_POINT)) {
            free(path);
            set_reason(reason, reason_size, "bind backing mount-point ACL grant failed");
            return 0;
        }
        if (!grant_temporary(sandbox, path,
                             read_only
                                 ? FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_TRAVERSE
                                 : FILE_GENERIC_READ | FILE_GENERIC_WRITE |
                                       FILE_GENERIC_EXECUTE | DELETE,
                             SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                             (attributes != INVALID_FILE_ATTRIBUTES &&
                              (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
                                 ? OWC_ACL_REPARSE_TARGET
                                 : OWC_ACL_NAMED_PATH)) {
            free(path);
            set_reason(reason, reason_size, "bind backing ACL grant failed");
            return 0;
        }
        free(path);
    }
    /* Same best-effort ancestor traverse as the write roots: the backing
       tree is reached by traversing its ancestors, which the AppContainer
       may not own. */
#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
    for (i = 0; i < options->bind_count; ++i)
        (void)grant_ancestor_traverse(sandbox, options->bind_backing[i]);
#endif
    return 1;
}

/* readOnlyPaths get the same read/traverse/execute tier as a read-only
 * Bind Link backing: generic read grants for tools and data the sandboxed
 * process may consume but never modify.  Grants are purely additive, so a
 * path whose DACL this process cannot edit (for example a machine-wide tool
 * install owned by Administrators) is skipped best-effort - failing to add
 * access is already fail-closed and must not sink the whole configure.
 * Recorded and revoked through the same grant list as the write roots. */
static int grant_read_only_paths(owc_sandbox *sandbox,
                                 const owc_sandbox_options *options,
                                 char *reason, size_t reason_size) {
    size_t i;
    for (i = 0; i < options->read_only_count; ++i) {
        wchar_t *path = utf8_to_wide(options->read_only_paths[i]);
        DWORD attributes;
        if (!path) {
            set_reason(reason, reason_size, "readOnlyPaths entry is not valid UTF-8");
            return 0;
        }
        attributes = GetFileAttributesW(path);
        if (attributes != INVALID_FILE_ATTRIBUTES &&
            (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
            (void)grant_temporary(sandbox, path,
                                  FILE_TRAVERSE | FILE_READ_ATTRIBUTES | SYNCHRONIZE,
                                  NO_INHERITANCE, OWC_ACL_REPARSE_POINT);
        (void)grant_temporary(sandbox, path,
                              FILE_GENERIC_READ | FILE_GENERIC_EXECUTE | FILE_TRAVERSE,
                              SUB_CONTAINERS_AND_OBJECTS_INHERIT,
                              (attributes != INVALID_FILE_ATTRIBUTES &&
                               (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
                                  ? OWC_ACL_REPARSE_TARGET
                                  : OWC_ACL_NAMED_PATH);
        free(path);
    }
#ifndef OWC_SANDBOX_TEST_SKIP_ANCESTORS
    for (i = 0; i < options->read_only_count; ++i)
        (void)grant_ancestor_traverse(sandbox, options->read_only_paths[i]);
#endif
    return 1;
}

/* denyPaths are files or directories the sandboxed process must not touch
 * even though an ancestor write root grants access.  A DENY ACE cannot
 * express this for AppContainer: the package leg of the access check is
 * allow-only, and a DENY ACE for the package SID does not sink it (verified
 * empirically: deny + inherited allow for the same package SID still
 * reads).  Enforcement therefore strips this command's own package-SID
 * ACEs from each deny path after the write-root grant has propagated them;
 * without a package-leg allow the object is unreachable.
 *
 * Two mechanics make this stick and stay revertible:
 * - The write-root grant propagates the package-SID allow into the deny
 *   path as an *inherited* ACE, and an unprotected DACL write re-inherits
 *   it from the parent at write time - so the top deny path is written
 *   with PROTECTED_DACL (inheritance frozen), while descendants re-inherit
 *   cleanly from the already-stripped parent and need no protection.
 * - The pre-strip DACL bytes are saved in the process-wide deny-strip
 *   registry (shared when concurrent commands strip the same path); the
 *   last holder's destroy writes them back minus every registered SID with
 *   UNPROTECTED_DACL, which resumes inheritance and reproduces the
 *   pre-grant DACL.
 *
 * A missing path is skipped (nothing to leak yet; the next command re-runs
 * this strip); a strip failure on an existing path fails the whole create -
 * running with a silently open deny hole would be worse than not running. */

/* Remove every ACE for sid from one object's DACL and write it back.  With
   protect the write also freezes inheritance (PROTECTED_DACL) - required on
   the top deny path.  When saved is non-NULL it receives a copy of the
   pre-strip DACL for the destroy-time restore.  Returns ERROR_SUCCESS also
   when there was nothing to strip (nothing is written, *saved stays NULL). */
static DWORD strip_sid_from_dacl(const wchar_t *path, PSID sid, int protect,
                                 unsigned char **saved, DWORD *saved_size) {
    PACL old_acl = NULL, new_acl = NULL;
    PSECURITY_DESCRIPTOR descriptor = NULL;
    ACL_SIZE_INFORMATION info;
    DWORD error, i;
    int removed = 0;
    (void)InitOnceExecuteOnce(&acl_once, acl_mutex_init, NULL, NULL);
    EnterCriticalSection(&acl_mutex);
    error = GetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                  DACL_SECURITY_INFORMATION, NULL, NULL,
                                  &old_acl, NULL, &descriptor);
    if (error != ERROR_SUCCESS) goto done;
    if (!old_acl) {
        /* A null DACL grants everyone full control; no strip can secure
           that, so fail closed instead of pretending. */
        error = ERROR_INVALID_ACCESS;
        goto done;
    }
    if (!GetAclInformation(old_acl, &info, sizeof(info), AclSizeInformation)) {
        error = GetLastError();
        goto done;
    }
    new_acl = (PACL)LocalAlloc(LPTR, info.AclBytesInUse + sizeof(ACL));
    if (!new_acl ||
        !InitializeAcl(new_acl, info.AclBytesInUse + sizeof(ACL), ACL_REVISION)) {
        error = new_acl ? GetLastError() : ERROR_OUTOFMEMORY;
        goto done;
    }
    for (i = 0; i < old_acl->AceCount; ++i) {
        ACE_HEADER *ace = NULL;
        PSID ace_sid = NULL;
        if (!GetAce(old_acl, i, (LPVOID *)&ace) || !ace) continue;
        if (ace->AceType == ACCESS_ALLOWED_ACE_TYPE)
            ace_sid = (PSID)&((ACCESS_ALLOWED_ACE *)ace)->SidStart;
        else if (ace->AceType == ACCESS_DENIED_ACE_TYPE)
            ace_sid = (PSID)&((ACCESS_DENIED_ACE *)ace)->SidStart;
        if (ace_sid && EqualSid(ace_sid, sid)) {
            removed = 1;
            continue;
        }
        if (!AddAce(new_acl, ACL_REVISION, MAXDWORD, ace, ace->AceSize)) {
            error = GetLastError();
            goto done;
        }
    }
    if (removed) {
        if (saved) {
            *saved = (unsigned char *)malloc(info.AclBytesInUse);
            if (!*saved) {
                error = ERROR_OUTOFMEMORY;
                goto done;
            }
            (void)memcpy(*saved, old_acl, info.AclBytesInUse);
            *saved_size = info.AclBytesInUse;
        }
        error = SetNamedSecurityInfoW((LPWSTR)path, SE_FILE_OBJECT,
                                      DACL_SECURITY_INFORMATION |
                                          (protect ? PROTECTED_DACL_SECURITY_INFORMATION : 0),
                                      NULL, NULL, new_acl, NULL);
        if (error != ERROR_SUCCESS && saved) {
            /* The caller takes ownership of the saved bytes only on
             * success; free them here or the failure path leaks. */
            free(*saved);
            *saved = NULL;
            *saved_size = 0;
        }
    }
done:
    LeaveCriticalSection(&acl_mutex);
    if (new_acl) LocalFree(new_acl);
    if (descriptor) LocalFree(descriptor);
    return error;
}

/* Directory deny paths need a recursive strip: the write-root grant
   propagates the package-SID allow onto every existing descendant, and the
   bypass-traverse privilege means stripping only the directory itself would
   leave the children reachable.  Bounded so a hostile tree cannot wedge the
   create: a node cap, and a separate depth cap because every recursion
   level holds a WIN32_FIND_DATAW (~600 bytes) plus an open find handle on
   the stack - a single-chain tree would overflow the 1 MiB default stack
   long before the node cap.  Only the top node goes through the deny-strip
   registry (freeze + restore record); descendants re-inherit from their
   already-stripped parent. */
#define OWC_DENY_STRIP_MAX_NODES 8192ul
#define OWC_DENY_STRIP_MAX_DEPTH 64ul

/* Top-level deny path: go through the process-wide registry so concurrent
 * commands stripping the same path share one snapshot and the restore runs
 * only when the last holder exits. */
static int strip_deny_top(owc_sandbox *sandbox, const wchar_t *path,
                          char *reason, size_t reason_size) {
    DWORD error;
    size_t length;
    wchar_t *copy;
    (void)InitOnceExecuteOnce(&acl_once, acl_mutex_init, NULL, NULL);
    EnterCriticalSection(&acl_mutex);
    error = deny_strip_acquire(path, sandbox->appcontainer_sid);
    LeaveCriticalSection(&acl_mutex);
    if (error != ERROR_SUCCESS) {
        (void)snprintf(reason, reason_size, "denyPaths strip failed (error=%lu)",
                       (unsigned long)error);
        return 0;
    }
    length = wcslen(path) + 1;
    copy = (wchar_t *)malloc(length * sizeof(*copy));
    if (copy) (void)memcpy(copy, path, length * sizeof(*copy));
    if (!copy ||
        !remember_grant(sandbox, copy, OWC_ACL_DENY_PATH, NULL, 0)) {
        /* Undo the registration so a failed create leaves no residue. */
        release_deny_strip_grant(path);
        free(copy);
        set_reason(reason, reason_size, "denyPaths strip tracking failed");
        return 0;
    }
    return 1;
}

static int strip_deny_path(owc_sandbox *sandbox, const wchar_t *path,
                           unsigned long *nodes, unsigned long depth, int top,
                           char *reason, size_t reason_size) {
    DWORD attributes = GetFileAttributesW(path);
    DWORD error;
    if (attributes == INVALID_FILE_ATTRIBUTES) {
        error = GetLastError();
        if (error == ERROR_FILE_NOT_FOUND || error == ERROR_PATH_NOT_FOUND)
            return 1;
        (void)snprintf(reason, reason_size,
                       "denyPaths entry could not be queried (error=%lu)",
                       (unsigned long)error);
        return 0;
    }
    if (++*nodes > OWC_DENY_STRIP_MAX_NODES) {
        set_reason(reason, reason_size,
                   "denyPaths directory has too many entries to secure");
        return 0;
    }
    if (depth > OWC_DENY_STRIP_MAX_DEPTH) {
        set_reason(reason, reason_size,
                   "denyPaths directory is nested too deeply to secure");
        return 0;
    }
    if (top) {
        if (!strip_deny_top(sandbox, path, reason, reason_size)) return 0;
    } else {
        error = strip_sid_from_dacl(path, sandbox->appcontainer_sid, 0,
                                    NULL, NULL);
        if (error != ERROR_SUCCESS) {
            (void)snprintf(reason, reason_size,
                           "denyPaths strip failed (error=%lu)", (unsigned long)error);
            return 0;
        }
    }
    if (!(attributes & FILE_ATTRIBUTE_DIRECTORY) ||
        (attributes & FILE_ATTRIBUTE_REPARSE_POINT))
        return 1;
    {
        wchar_t *pattern;
        size_t length = wcslen(path);
        WIN32_FIND_DATAW data;
        HANDLE find;
        int ok = 1;
        pattern = (wchar_t *)malloc((length + 3) * sizeof(*pattern));
        if (!pattern) {
            set_reason(reason, reason_size, "denyPaths strip allocation failed");
            return 0;
        }
        (void)memcpy(pattern, path, length * sizeof(*pattern));
        pattern[length] = L'\\';
        pattern[length + 1] = L'*';
        pattern[length + 2] = L'\0';
        find = FindFirstFileW(pattern, &data);
        free(pattern);
        if (find == INVALID_HANDLE_VALUE) {
            /* ERROR_FILE_NOT_FOUND is an empty directory (nothing to
             * strip); anything else means the children could not be
             * enumerated, so the tree is only partially stripped and the
             * create must fail closed. */
            error = GetLastError();
            if (error == ERROR_FILE_NOT_FOUND) return 1;
            (void)snprintf(reason, reason_size,
                           "denyPaths directory enumeration failed (error=%lu)",
                           (unsigned long)error);
            return 0;
        }
        do {
            wchar_t *child;
            size_t name_length;
            if (!wcscmp(data.cFileName, L".") || !wcscmp(data.cFileName, L".."))
                continue;
            name_length = wcslen(data.cFileName);
            child = (wchar_t *)malloc((length + 1 + name_length + 1) * sizeof(*child));
            if (!child) {
                set_reason(reason, reason_size, "denyPaths strip allocation failed");
                ok = 0;
                break;
            }
            (void)memcpy(child, path, length * sizeof(*child));
            child[length] = L'\\';
            (void)memcpy(child + length + 1, data.cFileName,
                         (name_length + 1) * sizeof(*child));
            ok = strip_deny_path(sandbox, child, nodes, depth + 1, 0,
                                 reason, reason_size);
            free(child);
        } while (ok && FindNextFileW(find, &data));
        if (ok) {
            /* FindNextFileW also ends the loop on a real error (short read,
               lost handle); only ERROR_NO_MORE_FILES means the directory
               was fully enumerated. */
            error = GetLastError();
            if (error != ERROR_NO_MORE_FILES) {
                (void)snprintf(reason, reason_size,
                               "denyPaths directory enumeration failed (error=%lu)",
                               (unsigned long)error);
                ok = 0;
            }
        }
        FindClose(find);
        return ok;
    }
}

/* Prefix a drive-letter or UNC absolute path with \\?\ so deny-path
   stripping is not bound by MAX_PATH. */
static wchar_t *extend_path(const wchar_t *path) {
    static const wchar_t prefix[] = L"\\\\?\\";
    static const wchar_t unc_prefix[] = L"\\\\?\\UNC\\";
    size_t length = wcslen(path), extra;
    wchar_t *out;
    if (length >= 4 && !wcsncmp(path, prefix, 4)) {
        out = (wchar_t *)malloc((length + 1) * sizeof(*out));
        if (out) (void)memcpy(out, path, (length + 1) * sizeof(*out));
        return out;
    }
    if (length >= 2 && path[0] == L'\\' && path[1] == L'\\') {
        extra = ARRAYSIZE(unc_prefix) - 1;
        out = (wchar_t *)malloc((extra + length - 2 + 1) * sizeof(*out));
        if (!out) return NULL;
        (void)memcpy(out, unc_prefix, extra * sizeof(*out));
        (void)memcpy(out + extra, path + 2, (length - 2 + 1) * sizeof(*out));
        return out;
    }
    extra = ARRAYSIZE(prefix) - 1;
    out = (wchar_t *)malloc((extra + length + 1) * sizeof(*out));
    if (!out) return NULL;
    (void)memcpy(out, prefix, extra * sizeof(*out));
    (void)memcpy(out + extra, path, (length + 1) * sizeof(*out));
    return out;
}

static int strip_deny_paths(owc_sandbox *sandbox,
                            const owc_sandbox_options *options,
                            char *reason, size_t reason_size) {
    size_t i;
    unsigned long nodes = 0;
    for (i = 0; i < options->deny_count; ++i) {
        wchar_t *path = utf8_to_wide(options->deny_paths[i]);
        wchar_t *extended;
        size_t length;
        if (!path) {
            set_reason(reason, reason_size, "denyPaths entry is not valid UTF-8");
            return 0;
        }
        length = wcslen(path);
        while (length > 3 && (path[length - 1] == L'\\' || path[length - 1] == L'/'))
            path[--length] = L'\0';
        extended = extend_path(path);
        free(path);
        if (!extended) {
            set_reason(reason, reason_size, "denyPaths strip allocation failed");
            return 0;
        }
        if (!strip_deny_path(sandbox, extended, &nodes, 0, 1,
                             reason, reason_size)) {
            free(extended);
            return 0;
        }
        free(extended);
    }
    return 1;
}

static wchar_t *make_profile_name(const char *session_id) {
    static const wchar_t prefix[] = L"OpenWebCode.";
    size_t input_length = strlen(session_id), i, prefix_length = ARRAYSIZE(prefix) - 1;
    wchar_t *name = (wchar_t *)calloc(prefix_length + input_length + 1, sizeof(*name));
    if (!name) return NULL;
    (void)memcpy(name, prefix, prefix_length * sizeof(*name));
    for (i = 0; i < input_length; ++i) {
        unsigned char c = (unsigned char)session_id[i];
        name[prefix_length + i] = (c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') ||
                                  (c >= '0' && c <= '9') || c == '.' || c == '-'
                                      ? (wchar_t)c : L'_';
    }
    return name;
}

static INIT_ONCE sandbox_probe_once = INIT_ONCE_STATIC_INIT;
static owc_sandbox_status sandbox_probe_status = OWC_SANDBOX_ADVISORY;
static char sandbox_probe_reason[192];

/* The probe launches a one-time verification process on first use: profile
 * creation alone only proves the API exists, not that the security
 * capabilities process attribute is honored end to end.  A successful
 * "cmd.exe /c exit 0" under PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES
 * upgrades the reported capability from partial to enforced; any failure
 * keeps partial with the real failure point recorded. */
static void probe_process_attribute(PSID sid) {
    wchar_t system_dir[MAX_PATH];
    wchar_t command[MAX_PATH + 16];
    SECURITY_CAPABILITIES capabilities;
    STARTUPINFOEXW startup;
    PROCESS_INFORMATION process;
    LPPROC_THREAD_ATTRIBUTE_LIST attributes = NULL;
    SIZE_T attribute_size = 0;
    DWORD length, error, exit_code = 1, wait_result;
    memset(&capabilities, 0, sizeof(capabilities));
    memset(&startup, 0, sizeof(startup));
    memset(&process, 0, sizeof(process));
    length = GetSystemDirectoryW(system_dir, (UINT)ARRAYSIZE(system_dir));
    if (!length || length >= ARRAYSIZE(system_dir) - 8 ||
        wcscat_s(system_dir, ARRAYSIZE(system_dir), L"\\cmd.exe") != 0 ||
        swprintf_s(command, ARRAYSIZE(command), L"\"%ls\" /c exit 0",
                   system_dir) < 0) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe command construction failed; per-process enforcement is unverified");
        return;
    }
    capabilities.AppContainerSid = sid;
    (void)InitializeProcThreadAttributeList(NULL, 1, 0, &attribute_size);
    if (!attribute_size) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe attribute list sizing failed; per-process enforcement is unverified");
        return;
    }
    attributes = (LPPROC_THREAD_ATTRIBUTE_LIST)malloc(attribute_size);
    if (!attributes ||
        !InitializeProcThreadAttributeList(attributes, 1, 0, &attribute_size)) {
        free(attributes);
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe attribute list initialization failed; per-process enforcement is unverified");
        return;
    }
    if (!UpdateProcThreadAttribute(attributes, 0,
                                   PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                   &capabilities, sizeof(capabilities),
                                   NULL, NULL)) {
        error = GetLastError();
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe security capabilities attribute failed (error=%lu)",
                       (unsigned long)error);
        goto done;
    }
    startup.StartupInfo.cb = sizeof(startup);
    startup.lpAttributeList = attributes;
    if (!CreateProcessW(NULL, command, NULL, NULL, FALSE,
                        CREATE_NO_WINDOW | EXTENDED_STARTUPINFO_PRESENT,
                        NULL, NULL, &startup.StartupInfo, &process)) {
        error = GetLastError();
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe process creation failed (error=%lu); per-process enforcement is unverified",
                       (unsigned long)error);
        goto done;
    }
    wait_result = WaitForSingleObject(process.hProcess, 10000);
    if (wait_result != WAIT_OBJECT_0) {
        (void)TerminateProcess(process.hProcess, 1);
        (void)WaitForSingleObject(process.hProcess, 2000);
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe process did not exit in time (wait=%lu)",
                       (unsigned long)wait_result);
    } else if (!GetExitCodeProcess(process.hProcess, &exit_code) || exit_code != 0) {
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer probe process exited with code %lu",
                       (unsigned long)exit_code);
    } else {
        sandbox_probe_status = OWC_SANDBOX_ENFORCED;
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer verified end-to-end (profile + process attribute)");
    }
    CloseHandle(process.hThread);
    CloseHandle(process.hProcess);
done:
    DeleteProcThreadAttributeList(attributes);
    free(attributes);
}

static BOOL CALLBACK sandbox_probe_init(PINIT_ONCE once, PVOID param,
                                        PVOID *context) {
    wchar_t profile_name[64];
    PSID sid = NULL;
    HRESULT hr;
    int profile_available = 0;
    (void)once; (void)param; (void)context;
    if (swprintf_s(profile_name, ARRAYSIZE(profile_name),
                   L"OpenWebCode.Probe.%lu",
                   (unsigned long)GetCurrentProcessId()) < 0) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer probe name creation failed");
        return TRUE;
    }
    hr = CreateAppContainerProfile(profile_name, profile_name,
                                   L"OpenWebCode capability probe", NULL, 0,
                                   &sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(profile_name, &sid);
        profile_available = SUCCEEDED(hr);
    } else {
        profile_available = SUCCEEDED(hr);
    }
    if (profile_available && sid) {
        sandbox_probe_status = OWC_SANDBOX_PARTIAL;
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer profile creation is available; per-process enforcement has not yet been verified");
        probe_process_attribute(sid);
        FreeSid(sid);
        (void)DeleteAppContainerProfile(profile_name);
        return TRUE;
    }
    if (profile_available) {
        (void)DeleteAppContainerProfile(profile_name);
        sandbox_probe_status = OWC_SANDBOX_PARTIAL;
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer profile creation returned no SID; per-process enforcement is unverified");
        return TRUE;
    }
    if (sid) FreeSid(sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_CALL_NOT_IMPLEMENTED) ||
        hr == HRESULT_FROM_WIN32(ERROR_PROC_NOT_FOUND)) {
        set_reason(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                   "AppContainer APIs are not supported by this Windows version");
    } else {
        (void)snprintf(sandbox_probe_reason, sizeof(sandbox_probe_reason),
                       "AppContainer profile creation is unavailable (HRESULT=0x%08lx)",
                       (unsigned long)hr);
    }
    return TRUE;
}

const char *owc_sandbox_status_name(owc_sandbox_status status) {
    if (status == OWC_SANDBOX_ENFORCED) return "enforced";
    if (status == OWC_SANDBOX_PARTIAL) return "partial";
    return "advisory";
}

owc_sandbox_status owc_sandbox_probe(char *reason, size_t reason_size) {
    (void)InitOnceExecuteOnce(&sandbox_probe_once, sandbox_probe_init,
                              NULL, NULL);
    set_reason(reason, reason_size, sandbox_probe_reason);
    return sandbox_probe_status;
}

owc_sandbox *owc_sandbox_create(const owc_sandbox_options *options,
                                char *reason, size_t reason_size) {
    owc_sandbox *sandbox;
    HRESULT hr;
    if (!options || !options->session_id || !options->session_id[0]) {
        set_reason(reason, reason_size, "sandbox requires a non-empty session id");
        return NULL;
    }
    sandbox = (owc_sandbox *)calloc(1, sizeof(*sandbox));
    if (!sandbox) {
        set_reason(reason, reason_size, "sandbox allocation failed");
        return NULL;
    }
    sandbox->status = OWC_SANDBOX_PARTIAL;
    sandbox->shared_profile = options->shared_profile ? 1 : 0;
    sandbox->profile_name = make_profile_name(options->session_id);
    if (!sandbox->profile_name) goto fail;

    /* Convert the requested capability SIDs BEFORE profile creation: a
       process can only receive SECURITY_CAPABILITIES entries that its
       profile carries, and a profile created with zero capabilities
       silently drops every requested capability (CreateProcess still
       succeeds).  The same SID set therefore goes to both the profile and
       the per-process attribute. */
    if (options->allow_network) {
        size_t capability_count = 0;
        if (!ConvertStringSidToSidW(L"S-1-15-3-1", &sandbox->capability_sids[capability_count])) {
            set_reason(reason, reason_size, "internetClient capability SID creation failed");
            goto fail;
        }
        sandbox->capabilities[capability_count].Sid = sandbox->capability_sids[capability_count];
        sandbox->capabilities[capability_count].Attributes = SE_GROUP_ENABLED;
        capability_count++;
        if (options->private_network) {
            if (!ConvertStringSidToSidW(L"S-1-15-3-3", &sandbox->capability_sids[capability_count])) {
                set_reason(reason, reason_size, "privateNetworkClientServer capability SID creation failed");
                goto fail;
            }
            sandbox->capabilities[capability_count].Sid = sandbox->capability_sids[capability_count];
            sandbox->capabilities[capability_count].Attributes = SE_GROUP_ENABLED;
            capability_count++;
        }
        sandbox->security_capabilities.Capabilities = sandbox->capabilities;
        sandbox->security_capabilities.CapabilityCount = (DWORD)capability_count;
    }

    hr = CreateAppContainerProfile(sandbox->profile_name, sandbox->profile_name,
                                   L"OpenWebCode command session",
                                   sandbox->security_capabilities.Capabilities,
                                   sandbox->security_capabilities.CapabilityCount,
                                   &sandbox->appcontainer_sid);
    if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) {
        hr = DeriveAppContainerSidFromAppContainerName(sandbox->profile_name,
                                                        &sandbox->appcontainer_sid);
        if (FAILED(hr)) {
            set_reason(reason, reason_size, "existing AppContainer SID derivation failed");
            goto fail;
        }
    } else if (FAILED(hr)) {
        if (reason && reason_size > 0)
            (void)snprintf(reason, reason_size,
                           "AppContainer profile creation failed (HRESULT=0x%08lx); sandbox is partial",
                           (unsigned long)hr);
        goto fail;
    } else {
        /* A shared profile belongs to the session grant: even when this
           per-command create happened to win the creation race, destroy must
           never delete it. */
        sandbox->profile_created = sandbox->shared_profile ? 0 : 1;
    }

    sandbox->security_capabilities.AppContainerSid = sandbox->appcontainer_sid;
    sandbox->security_capabilities.Reserved = 0;

    if (!sandbox->shared_profile) {
        if (!grant_write_roots(sandbox, options, reason, reason_size)) goto fail;
        if (!grant_read_only_paths(sandbox, options, reason, reason_size)) goto fail;
        if (!grant_bind_backings(sandbox, options, reason, reason_size)) goto fail;
        if (!strip_deny_paths(sandbox, options, reason, reason_size)) goto fail;
    }
    sandbox->status = OWC_SANDBOX_ENFORCED;
    set_reason(reason, reason_size, "AppContainer prepared; enforcement begins only after process creation uses its attribute");
    return sandbox;
fail:
    owc_sandbox_destroy(sandbox);
    return NULL;
}

int owc_sandbox_add_process_attribute(owc_sandbox *sandbox,
                                      LPPROC_THREAD_ATTRIBUTE_LIST attributes,
                                      char *reason, size_t reason_size) {
    if (!sandbox || !attributes) return 0;
    if (!UpdateProcThreadAttribute(attributes, 0,
                                    PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES,
                                    &sandbox->security_capabilities,
                                    sizeof(sandbox->security_capabilities), NULL, NULL)) {
        set_reason(reason, reason_size, "process security capabilities attribute could not be applied");
        return 0;
    }
    sandbox->attribute_applied = 1;
    return 1;
}

owc_sandbox_status owc_sandbox_get_status(const owc_sandbox *sandbox) {
    if (!sandbox) return OWC_SANDBOX_ADVISORY;
    if (!sandbox->attribute_applied) return OWC_SANDBOX_PARTIAL;
    return sandbox->status == OWC_SANDBOX_PARTIAL ? OWC_SANDBOX_PARTIAL : OWC_SANDBOX_ENFORCED;
}

void owc_sandbox_destroy(owc_sandbox *sandbox) {
    size_t i;
    if (!sandbox) return;
    revoke_write_roots(sandbox);
    for (i = 0; i < ARRAYSIZE(sandbox->capability_sids); ++i)
        if (sandbox->capability_sids[i]) LocalFree(sandbox->capability_sids[i]);
    if (sandbox->appcontainer_sid) FreeSid(sandbox->appcontainer_sid);
    if (sandbox->profile_created && sandbox->profile_name)
        (void)DeleteAppContainerProfile(sandbox->profile_name);
    free(sandbox->profile_name);
    free(sandbox);
}

/* Session-scoped registry for filtered-network sessions: the fixed
 * OpenWebCode.<session-id> profile and its ACL grants live from configure to
 * cleanup/reconfigure/exit so the business processes and the in-sandbox
 * proxy sidecar share one package identity (same-package loopback is the
 * mechanism that lets the capability-less business process reach the
 * sidecar).  Bounded and mutex-guarded like the ACL RMW above. */
#define OWC_SANDBOX_MAX_SESSION_GRANTS 16u
static INIT_ONCE session_grant_once = INIT_ONCE_STATIC_INIT;
static CRITICAL_SECTION session_grant_mutex;
static struct {
    char *session_id;
    owc_sandbox *sandbox;
} session_grants[OWC_SANDBOX_MAX_SESSION_GRANTS];
static size_t session_grant_count = 0;

static BOOL CALLBACK session_grant_mutex_init(PINIT_ONCE once, PVOID param,
                                              PVOID *context) {
    (void)once; (void)param; (void)context;
    InitializeCriticalSection(&session_grant_mutex);
    return TRUE;
}

static size_t session_grant_find(const char *session_id) {
    size_t i;
    for (i = 0; i < session_grant_count; ++i)
        if (!strcmp(session_grants[i].session_id, session_id)) return i;
    return session_grant_count;
}

static void session_grant_remove(size_t index) {
    owc_sandbox_destroy(session_grants[index].sandbox);
    free(session_grants[index].session_id);
    if (index != session_grant_count - 1)
        session_grants[index] = session_grants[session_grant_count - 1];
    session_grant_count--;
}

int owc_sandbox_session_grant(const char *session_id,
                              const owc_sandbox_options *options,
                              char *reason, size_t reason_size) {
    owc_sandbox *sandbox;
    char *id_copy;
    size_t index;
    if (!session_id || !session_id[0] || !options) {
        set_reason(reason, reason_size, "sandbox session grant requires a non-empty session id");
        return 0;
    }
    (void)InitOnceExecuteOnce(&session_grant_once, session_grant_mutex_init,
                              NULL, NULL);
    /* Idempotent re-grant: revoke the previous grant first, because creating
       the replacement would derive the still-registered profile and the old
       grant's destroy would then delete it under the new SID. */
    EnterCriticalSection(&session_grant_mutex);
    index = session_grant_find(session_id);
    if (index < session_grant_count) session_grant_remove(index);
    LeaveCriticalSection(&session_grant_mutex);
    /* Stale profiles from crashed or older cores may carry the wrong
       capability set; recreate so the grant always owns a fresh profile.
       Best effort: deletion fails while a process still uses the profile. */
    {
        wchar_t *stale = make_profile_name(session_id);
        if (stale) {
            (void)DeleteAppContainerProfile(stale);
            free(stale);
        }
    }
    sandbox = owc_sandbox_create(options, reason, reason_size);
    if (!sandbox) return 0;
    id_copy = (char *)malloc(strlen(session_id) + 1);
    if (!id_copy) {
        owc_sandbox_destroy(sandbox);
        set_reason(reason, reason_size, "sandbox session grant allocation failed");
        return 0;
    }
    (void)strcpy(id_copy, session_id);
    EnterCriticalSection(&session_grant_mutex);
    if (session_grant_count >= OWC_SANDBOX_MAX_SESSION_GRANTS) {
        LeaveCriticalSection(&session_grant_mutex);
        free(id_copy);
        owc_sandbox_destroy(sandbox);
        set_reason(reason, reason_size, "sandbox session grant limit reached");
        return 0;
    }
    session_grants[session_grant_count].session_id = id_copy;
    session_grants[session_grant_count].sandbox = sandbox;
    session_grant_count++;
    LeaveCriticalSection(&session_grant_mutex);
    return 1;
}

void owc_sandbox_session_revoke(const char *session_id) {
    size_t index;
    if (!session_id) return;
    (void)InitOnceExecuteOnce(&session_grant_once, session_grant_mutex_init,
                              NULL, NULL);
    EnterCriticalSection(&session_grant_mutex);
    index = session_grant_find(session_id);
    if (index < session_grant_count) session_grant_remove(index);
    LeaveCriticalSection(&session_grant_mutex);
}

void owc_sandbox_session_revoke_all(void) {
    (void)InitOnceExecuteOnce(&session_grant_once, session_grant_mutex_init,
                              NULL, NULL);
    EnterCriticalSection(&session_grant_mutex);
    while (session_grant_count) session_grant_remove(session_grant_count - 1);
    LeaveCriticalSection(&session_grant_mutex);
}
