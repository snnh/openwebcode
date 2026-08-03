#include "../overlay.h"

#include "../path_policy.h"

#include <dirent.h>
#include <errno.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/stat.h>
#include <sys/types.h>
#include <sys/wait.h>

#ifdef __linux__
#include <sys/ioctl.h>
#include <sys/mount.h>
#include <sys/xattr.h>
#include <linux/fs.h>
#endif

#ifndef PATH_MAX
#define PATH_MAX 4096
#endif

#ifdef __linux__

/* ------------------------------------------------------------------ */
/* Small shared helpers.  All err messages are short ASCII strings.    */

static void store_err(char *err, size_t err_size, const char *what) {
    if (err && err_size) (void)snprintf(err,err_size,"%s: %s",what,strerror(errno));
}

static void store_text(char *err, size_t err_size, const char *what) {
    if (err && err_size) (void)snprintf(err,err_size,"%s",what);
}

static int path_has_executable(const char *name) {
    const char *path=getenv("PATH");
    const char *cursor;
    char candidate[PATH_MAX];
    if(!path||!path[0]) path="/usr/local/bin:/usr/bin:/bin";
    cursor=path;
    for(;;) {
        const char *colon=strchr(cursor,':');
        size_t dir_length=colon?(size_t)(colon-cursor):strlen(cursor);
        size_t name_length=strlen(name);
        if(dir_length && dir_length+1u+name_length<sizeof(candidate)) {
            memcpy(candidate,cursor,dir_length);
            candidate[dir_length]='/';
            memcpy(candidate+dir_length+1,name,name_length+1);
            if(access(candidate,X_OK)==0) return 1;
        }
        if(!colon) break;
        cursor=colon+1;
    }
    return 0;
}

/* stateRoot must exist and be a directory; resolved form is the authority
 * every other resolved path is checked against. */
static int resolve_root(const char *state_root, char *root_resolved, size_t size, char *err, size_t err_size) {
    char *rp; struct stat st;
    if(!state_root||!state_root[0]) { store_text(err,err_size,"stateRoot is required"); return 0; }
    rp=realpath(state_root,NULL);
    if(!rp) { store_err(err,err_size,"stateRoot does not resolve"); return 0; }
    if(stat(rp,&st)!=0||!S_ISDIR(st.st_mode)) { free(rp); store_text(err,err_size,"stateRoot is not a directory"); return 0; }
    if(strlen(rp)>=size) { free(rp); store_text(err,err_size,"stateRoot path is too long"); return 0; }
    (void)strcpy(root_resolved,rp);
    free(rp);
    return 1;
}

/* Resolve an existing path and require it strictly below root_resolved.
 * This is the symlink-escape gate: the RPC layer already validated the
 * lexical form, realpath here collapses any symlinked components. */
static int resolve_existing_within(const char *path, const char *root_resolved, char *out, size_t out_size, char *err, size_t err_size) {
    char *rp=realpath(path,NULL);
    if(!rp) { store_err(err,err_size,"path does not resolve"); return 0; }
    if(!owc_path_is_within(rp,root_resolved)||!strcmp(rp,root_resolved)) {
        free(rp);
        store_text(err,err_size,"path resolves outside stateRoot (symlink escape refused)");
        return 0;
    }
    if(strlen(rp)>=out_size) { free(rp); store_text(err,err_size,"path is too long"); return 0; }
    (void)strcpy(out,rp);
    free(rp);
    return 1;
}

static int resolve_lower(const char *lower, char *out, size_t out_size, char *err, size_t err_size) {
    char *rp; struct stat st;
    rp=realpath(lower,NULL);
    if(!rp) { store_err(err,err_size,"lower does not resolve"); return 0; }
    if(stat(rp,&st)!=0||!S_ISDIR(st.st_mode)) { free(rp); store_text(err,err_size,"lower is not an existing directory"); return 0; }
    if(strlen(rp)>=out_size) { free(rp); store_text(err,err_size,"lower path is too long"); return 0; }
    (void)strcpy(out,rp);
    free(rp);
    return 1;
}

static int dir_is_empty(const char *path, int *empty, char *err, size_t err_size) {
    DIR *dir=opendir(path);
    struct dirent *entry;
    if(!dir) { store_err(err,err_size,"cannot open directory"); return 0; }
    *empty=1;
    while((entry=readdir(dir))!=NULL) {
        if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,"..")) continue;
        *empty=0;
        break;
    }
    (void)closedir(dir);
    return 1;
}

/* Create path (including missing parents) component by component.  Every
 * existing component is lstat'd and must be a real directory: symlink
 * components are refused (no-follow), matching the fs.c O_NOFOLLOW stance.
 * require_empty additionally demands the final directory be empty. */
static int ensure_dir(const char *path, int require_empty, char *err, size_t err_size) {
    char buffer[PATH_MAX];
    size_t length=strlen(path),i;
    int empty;
    if(!length||path[0]!='/'||length>=sizeof(buffer)) { store_text(err,err_size,"path must be absolute and shorter than PATH_MAX"); return 0; }
    memcpy(buffer,path,length+1);
    for(i=1;i<=length;i++) {
        if(buffer[i]=='/'||buffer[i]=='\0') {
            char saved=buffer[i];
            struct stat st;
            buffer[i]='\0';
            if(lstat(buffer,&st)!=0) {
                if(errno!=ENOENT) { store_err(err,err_size,"cannot inspect path component"); return 0; }
                if(mkdir(buffer,0755)!=0) { store_err(err,err_size,"cannot create directory"); return 0; }
            } else if(S_ISLNK(st.st_mode)) {
                store_text(err,err_size,"path component is a symlink (refused)");
                return 0;
            } else if(!S_ISDIR(st.st_mode)) {
                store_text(err,err_size,"path component is not a directory");
                return 0;
            }
            buffer[i]=saved;
        }
    }
    if(require_empty) {
        if(!dir_is_empty(path,&empty,err,err_size)) return 0;
        if(!empty) { store_text(err,err_size,"directory must be empty"); return 0; }
    }
    return 1;
}

/* Fork/exec a short-lived helper (fuse-overlayfs, fusermount3, fusermount)
 * with its stderr captured for the error reply.  stdin/stdout go to
 * /dev/null so the helper can never touch the RPC stream.  The helper's
 * exit status is the verdict (libfuse's daemonizing parent exits only once
 * the mount is ready or has failed), so waitpid comes first; stderr is then
 * drained WITHOUT waiting for EOF, because a daemonized grandchild (the
 * FUSE daemon itself) keeps the pipe open for its whole lifetime. */
static int run_helper(char *const argv[], char *err, size_t err_size) {
    int pipefd[2];
    pid_t pid;
    int status;
    char captured[256];
    size_t captured_length=0;
    int flags;
    captured[0]='\0';
    if(pipe(pipefd)!=0) { store_err(err,err_size,"pipe failed"); return 0; }
    pid=fork();
    if(pid<0) {
        (void)close(pipefd[0]);
        (void)close(pipefd[1]);
        store_err(err,err_size,"fork failed");
        return 0;
    }
    if(pid==0) {
        int devnull;
        (void)close(pipefd[0]);
        (void)dup2(pipefd[1],STDERR_FILENO);
        devnull=open("/dev/null",O_RDWR);
        if(devnull>=0) {
            (void)dup2(devnull,STDIN_FILENO);
            (void)dup2(devnull,STDOUT_FILENO);
            if(devnull>STDERR_FILENO) (void)close(devnull);
        }
        execvp(argv[0],argv);
        _exit(127);
    }
    (void)close(pipefd[1]);
    while(waitpid(pid,&status,0)<0) {
        if(errno!=EINTR) { (void)close(pipefd[0]); store_err(err,err_size,"waitpid failed"); return 0; }
    }
    flags=fcntl(pipefd[0],F_GETFL,0);
    if(flags>=0) (void)fcntl(pipefd[0],F_SETFL,flags|O_NONBLOCK);
    for(;;) {
        ssize_t n=read(pipefd[0],captured+captured_length,sizeof(captured)-1u-captured_length);
        if(n<=0) break;
        captured_length+=(size_t)n;
        if(captured_length>=sizeof(captured)-1u) break;
    }
    captured[captured_length]='\0';
    (void)close(pipefd[0]);
    if(WIFEXITED(status)&&WEXITSTATUS(status)==0) return 1;
    while(captured_length&&(captured[captured_length-1]=='\n'||captured[captured_length-1]=='\r')) captured[--captured_length]='\0';
    if(err&&err_size) {
        if(captured_length) (void)snprintf(err,err_size,"%s failed: %s",argv[0],captured);
        else if(WIFEXITED(status)) (void)snprintf(err,err_size,"%s failed with exit code %d",argv[0],WEXITSTATUS(status));
        else (void)snprintf(err,err_size,"%s terminated abnormally",argv[0]);
    }
    return 0;
}

/* ------------------------------------------------------------------ */
/* Mount-method bookkeeping (in memory only; see overlay.h unmount).   */

#define OWC_OVERLAY_MAX_MOUNTS 16u

typedef struct {
    char merged[PATH_MAX]; /* realpath-resolved merged directory */
    int method;            /* OWC_OVERLAY_METHOD_* */
} overlay_mount_record;

static overlay_mount_record mount_records[OWC_OVERLAY_MAX_MOUNTS];
static size_t mount_record_count=0;

static int mount_record_find(const char *merged_resolved) {
    size_t i;
    for(i=0;i<mount_record_count;i++) if(!strcmp(mount_records[i].merged,merged_resolved)) return (int)i;
    return -1;
}

static int mount_record_add(const char *merged_resolved, int method) {
    if(strlen(merged_resolved)>=PATH_MAX||mount_record_count>=OWC_OVERLAY_MAX_MOUNTS) return 0;
    (void)strcpy(mount_records[mount_record_count].merged,merged_resolved);
    mount_records[mount_record_count].method=method;
    mount_record_count++;
    return 1;
}

static void mount_record_remove(size_t index) {
    size_t last=mount_record_count-1u;
    if(index!=last) mount_records[index]=mount_records[last];
    mount_record_count--;
}

/* /proc/mounts escapes space, tab, newline and backslash as \0NN octal. */
static void unescape_mount_field(const char *field, size_t length, char *out, size_t out_size) {
    size_t i=0,o=0;
    while(i<length&&o+1u<out_size) {
        if(field[i]=='\\'&&i+3u<length&&field[i+1]=='0'&&field[i+2]>='0'&&field[i+2]<='7'&&field[i+3]>='0'&&field[i+3]<='7') {
            out[o++]=(char)((field[i+2]-'0')*8+(field[i+3]-'0'));
            i+=4;
        } else {
            out[o++]=field[i++];
        }
    }
    out[o]='\0';
}

static int is_mounted(const char *merged_resolved) {
    FILE *fp=fopen("/proc/mounts","r");
    char line[8192];
    int found=0;
    if(!fp) return 0;
    while(fgets(line,sizeof(line),fp)) {
        char *p=line,*mp;
        char mountpoint[PATH_MAX];
        while(*p&&*p!=' ') p++;
        if(!*p) continue;
        p++;
        mp=p;
        while(*p&&*p!=' ') p++;
        unescape_mount_field(mp,(size_t)(p-mp),mountpoint,sizeof(mountpoint));
        if(!strcmp(mountpoint,merged_resolved)) { found=1; break; }
    }
    (void)fclose(fp);
    return found;
}

/* ------------------------------------------------------------------ */
/* Tree copy with reflink preference (checkpoint/restore payload).     */

/* Best-effort xattr copy: fuse-overlayfs whiteouts/opaque markers live in
 * user.* xattrs, so a checkpoint that drops them would resurrect deleted
 * files on restore.  Failures (fs without xattrs, permission) are ignored
 * by design; trusted.* needs CAP_SYS_ADMIN and is skipped for non-root. */
static void copy_xattrs(const char *source, const char *dest) {
    ssize_t list_length=llistxattr(source,NULL,0);
    char *list;
    size_t i;
    if(list_length<=0||(size_t)list_length>1024u*1024u) return;
    list=(char *)malloc((size_t)list_length);
    if(!list) return;
    list_length=llistxattr(source,list,(size_t)list_length);
    if(list_length<=0) { free(list); return; }
    i=0;
    while(i<(size_t)list_length) {
        const char *name=list+i;
        ssize_t value_length;
        char *value;
        i+=strlen(name)+1u;
        if(!strncmp(name,"trusted.",8)&&geteuid()!=0) continue;
        value_length=lgetxattr(source,name,NULL,0);
        if(value_length<0||(size_t)value_length>1024u*1024u) continue;
        value=(char *)malloc((size_t)value_length?(size_t)value_length:1u);
        if(!value) continue;
        value_length=lgetxattr(source,name,value,(size_t)value_length);
        if(value_length>=0) (void)lsetxattr(dest,name,value,(size_t)value_length,0);
        free(value);
    }
    free(list);
}

static int copy_entry(const char *source, const char *dest, owc_overlay_copy_summary *summary, char *err, size_t err_size);

static int copy_file(const char *source, const char *dest, const struct stat *st, owc_overlay_copy_summary *summary, char *err, size_t err_size) {
    int in=-1,out=-1,ok=0;
    in=open(source,O_RDONLY|O_NOFOLLOW|O_CLOEXEC);
    if(in<0) { store_err(err,err_size,"cannot open source file"); goto done; }
    out=open(dest,O_WRONLY|O_CREAT|O_EXCL|O_CLOEXEC,(mode_t)(st->st_mode&07777));
    if(out<0) { store_err(err,err_size,"cannot create destination file"); goto done; }
    /* Reflink first: one ioctl clones the extents on CoW filesystems. */
    if(ioctl(out,FICLONE,in)==0) goto copied;
    /* Then the kernel-side copy offload; fall back to a plain copy when the
     * filesystem cannot do it (ENOSYS/EXDEV/EINVAL and partial copies). */
    {
        off_t off_in=0,off_out=0;
        size_t remaining=(size_t)st->st_size;
        int offload_ok=1;
        while(remaining) {
            ssize_t n=copy_file_range(in,&off_in,out,&off_out,remaining,0);
            if(n<0) { offload_ok=0; break; }
            if(n==0) break;
            remaining-=(size_t)n;
        }
        if(offload_ok&&!remaining) goto copied;
        if(lseek(in,0,SEEK_SET)<0||ftruncate(out,0)!=0||lseek(out,0,SEEK_SET)<0) {
            store_err(err,err_size,"cannot rewind copy fallback");
            goto done;
        }
    }
    {
        char buffer[65536];
        for(;;) {
            ssize_t n=read(in,buffer,sizeof(buffer));
            if(n<0) {
                if(errno==EINTR) continue;
                store_err(err,err_size,"cannot read source file");
                goto done;
            }
            if(n==0) break;
            {
                size_t written=0;
                while(written<(size_t)n) {
                    ssize_t w=write(out,buffer+written,(size_t)n-written);
                    if(w<0) {
                        if(errno==EINTR) continue;
                        store_err(err,err_size,"cannot write destination file");
                        goto done;
                    }
                    written+=(size_t)w;
                }
            }
        }
    }
copied:
    (void)fchmod(out,(mode_t)(st->st_mode&07777));
    summary->files++;
    summary->bytes+=(unsigned long long)st->st_size;
    copy_xattrs(source,dest);
    ok=1;
done:
    if(in>=0) (void)close(in);
    if(out>=0) (void)close(out);
    return ok;
}

static int join_child(char *out, size_t out_size, const char *parent, const char *name) {
    size_t parent_length=strlen(parent),name_length=strlen(name);
    if(parent_length+1u+name_length>=out_size) return 0;
    memcpy(out,parent,parent_length);
    out[parent_length]='/';
    memcpy(out+parent_length+1,name,name_length+1);
    return 1;
}

static int copy_directory(const char *source, const char *dest, const struct stat *st, owc_overlay_copy_summary *summary, char *err, size_t err_size) {
    DIR *dir;
    struct dirent *entry;
    int ok=0;
    if(mkdir(dest,(mode_t)(st->st_mode&07777))!=0) { store_err(err,err_size,"cannot create directory"); return 0; }
    dir=opendir(source);
    if(!dir) { store_err(err,err_size,"cannot open source directory"); return 0; }
    while((entry=readdir(dir))!=NULL) {
        char child_source[PATH_MAX],child_dest[PATH_MAX];
        if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,"..")) continue;
        if(!join_child(child_source,sizeof(child_source),source,entry->d_name)||!join_child(child_dest,sizeof(child_dest),dest,entry->d_name)) {
            store_text(err,err_size,"path is too long");
            goto done;
        }
        if(!copy_entry(child_source,child_dest,summary,err,err_size)) goto done;
    }
    /* Restore mode after populating so read-only directories still fill. */
    (void)chmod(dest,(mode_t)(st->st_mode&07777));
    copy_xattrs(source,dest);
    ok=1;
done:
    (void)closedir(dir);
    return ok;
}

static int copy_entry(const char *source, const char *dest, owc_overlay_copy_summary *summary, char *err, size_t err_size) {
    struct stat st;
    if(lstat(source,&st)!=0) { store_err(err,err_size,"cannot stat source entry"); return 0; }
    if(S_ISDIR(st.st_mode)) return copy_directory(source,dest,&st,summary,err,err_size);
    if(S_ISREG(st.st_mode)) return copy_file(source,dest,&st,summary,err,err_size);
    if(S_ISLNK(st.st_mode)) {
        char target[PATH_MAX];
        ssize_t n=readlink(source,target,sizeof(target)-1u);
        if(n<0) { store_err(err,err_size,"cannot read symlink"); return 0; }
        target[n]='\0';
        if(symlink(target,dest)!=0) { store_err(err,err_size,"cannot create symlink"); return 0; }
        summary->files++;
        return 1;
    }
    /* Special files: kernel overlay whiteouts are char devices 0/0.  They can
     * only exist in a root-mounted upper, so recreating them needs root too;
     * anything else is reported as skipped instead of failing the copy. */
    if(geteuid()==0&&(S_ISCHR(st.st_mode)||S_ISBLK(st.st_mode)||S_ISFIFO(st.st_mode)||S_ISSOCK(st.st_mode))) {
        if(mknod(dest,st.st_mode,st.st_rdev)!=0) { store_err(err,err_size,"cannot recreate special file"); return 0; }
        return 1;
    }
    summary->skipped++;
    return 1;
}

/* Remove every child of path; symlinks are unlinked, never followed. */
static int clear_children(const char *path, char *err, size_t err_size) {
    DIR *dir=opendir(path);
    struct dirent *entry;
    int ok=0;
    if(!dir) { store_err(err,err_size,"cannot open directory"); return 0; }
    while((entry=readdir(dir))!=NULL) {
        char child[PATH_MAX];
        struct stat st;
        if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,"..")) continue;
        if(!join_child(child,sizeof(child),path,entry->d_name)) {
            store_text(err,err_size,"path is too long");
            goto done;
        }
        if(lstat(child,&st)!=0) { store_err(err,err_size,"cannot stat entry"); goto done; }
        if(S_ISDIR(st.st_mode)) {
            if(!clear_children(child,err,err_size)) goto done;
            if(rmdir(child)!=0) { store_err(err,err_size,"cannot remove directory"); goto done; }
        } else {
            if(unlink(child)!=0) { store_err(err,err_size,"cannot remove entry"); goto done; }
        }
    }
    ok=1;
done:
    (void)closedir(dir);
    return ok;
}

/* ------------------------------------------------------------------ */
/* Public primitives.                                                  */

int owc_overlay_supported(void) {
    owc_overlay_capabilities caps;
    owc_overlay_probe(&caps);
    return caps.supported;
}

void owc_overlay_probe(owc_overlay_capabilities *caps) {
    if(!caps) return;
    caps->fuse_overlayfs=path_has_executable("fuse-overlayfs");
    /* Only a root process can mount(2) an overlay that outlives the call:
     * a user-namespace mount would die with the helper process, so it is
     * deliberately not implemented and not advertised. */
    caps->kernel_mount=geteuid()==0;
    caps->supported=caps->fuse_overlayfs||caps->kernel_mount;
}

int owc_overlay_mount(const char *state_root, const char *lower,
                      const char *upper, const char *work, const char *merged,
                      int *method, char *err, size_t err_size) {
    char root_r[PATH_MAX],lower_r[PATH_MAX],upper_r[PATH_MAX],work_r[PATH_MAX],merged_r[PATH_MAX];
    char *options;
    size_t options_size;
    if(!resolve_root(state_root,root_r,sizeof(root_r),err,err_size)) return 0;
    if(!resolve_lower(lower,lower_r,sizeof(lower_r),err,err_size)) return 0;
    /* work must be empty (kernel overlayfs requirement); merged must be an
     * empty mountpoint; upper may hold a previous upper layer (restore
     * remounts a populated upper). */
    if(!ensure_dir(upper,0,err,err_size)||!ensure_dir(work,1,err,err_size)||!ensure_dir(merged,1,err,err_size)) return 0;
    if(!resolve_existing_within(upper,root_r,upper_r,sizeof(upper_r),err,err_size)) return 0;
    if(!resolve_existing_within(work,root_r,work_r,sizeof(work_r),err,err_size)) return 0;
    if(!resolve_existing_within(merged,root_r,merged_r,sizeof(merged_r),err,err_size)) return 0;
    if(!strcmp(merged_r,lower_r)) { store_text(err,err_size,"merged must differ from lower"); return 0; }
    options_size=strlen(lower_r)+strlen(upper_r)+strlen(work_r)+64u;
    options=(char *)malloc(options_size);
    if(!options) { store_text(err,err_size,"out of memory"); return 0; }
    (void)snprintf(options,options_size,"lowerdir=%s,upperdir=%s,workdir=%s",lower_r,upper_r,work_r);
    if(geteuid()==0) {
        if(mount("overlay",merged_r,"overlay",0,options)!=0) {
            store_err(err,err_size,"kernel overlay mount failed");
            free(options);
            return 0;
        }
        (void)mount_record_add(merged_r,OWC_OVERLAY_METHOD_KERNEL);
        if(method) *method=OWC_OVERLAY_METHOD_KERNEL;
        free(options);
        return 1;
    }
    if(!path_has_executable("fuse-overlayfs")) {
        free(options);
        store_text(err,err_size,"overlay mount requires root or fuse-overlayfs on PATH");
        return 0;
    }
    {
        char *argv[5];
        argv[0]=(char *)"fuse-overlayfs";
        argv[1]=(char *)"-o";
        argv[2]=options;
        argv[3]=merged_r;
        argv[4]=NULL;
        if(!run_helper(argv,err,err_size)) {
            /* fuse-overlayfs cleans up after itself on failure; verify so a
             * failed mount never leaves a half-mounted merged behind. */
            if(is_mounted(merged_r)) {
                char *uargv[4];
                uargv[0]=(char *)(path_has_executable("fusermount3")?"fusermount3":"fusermount");
                uargv[1]=(char *)"-u";
                uargv[2]=merged_r;
                uargv[3]=NULL;
                (void)run_helper(uargv,NULL,0);
            }
            free(options);
            return 0;
        }
    }
    (void)mount_record_add(merged_r,OWC_OVERLAY_METHOD_FUSE);
    if(method) *method=OWC_OVERLAY_METHOD_FUSE;
    free(options);
    return 1;
}

int owc_overlay_unmount(const char *merged, char *err, size_t err_size) {
    char merged_r[PATH_MAX];
    char *rp;
    int record;
    int method=0;
    rp=realpath(merged,NULL);
    if(!rp) {
        if(errno==ENOENT) return 1; /* directory is gone: nothing can be mounted there */
        store_err(err,err_size,"merged does not resolve");
        return 0;
    }
    if(strlen(rp)>=sizeof(merged_r)) { free(rp); store_text(err,err_size,"merged path is too long"); return 0; }
    (void)strcpy(merged_r,rp);
    free(rp);
    record=mount_record_find(merged_r);
    if(record>=0) method=mount_records[record].method;
    if(!is_mounted(merged_r)) {
        if(record>=0) mount_record_remove((size_t)record);
        return 1; /* not mounted: idempotent success */
    }
    /* Known method first; an unknown merged (mount table lost on restart)
     * tries umount2 before the fusermount helpers. */
    if(method!=OWC_OVERLAY_METHOD_FUSE) {
        if(umount2(merged_r,0)==0) {
            if(record>=0) mount_record_remove((size_t)record);
            return 1;
        }
    }
    if(method!=OWC_OVERLAY_METHOD_KERNEL) {
        const char *helper=path_has_executable("fusermount3")?"fusermount3":path_has_executable("fusermount")?"fusermount":NULL;
        if(helper) {
            char *argv[4];
            argv[0]=(char *)helper;
            argv[1]=(char *)"-u";
            argv[2]=merged_r;
            argv[3]=NULL;
            if(run_helper(argv,NULL,0)) {
                if(record>=0) mount_record_remove((size_t)record);
                return 1;
            }
        }
    }
    if(is_mounted(merged_r)) {
        store_text(err,err_size,"failed to unmount merged (still mounted after umount2/fusermount)");
        return 0;
    }
    if(record>=0) mount_record_remove((size_t)record);
    return 1;
}

int owc_overlay_copy_tree(const char *state_root, const char *source,
                          const char *dest, owc_overlay_copy_summary *summary,
                          char *err, size_t err_size) {
    char root_r[PATH_MAX],source_r[PATH_MAX],parent[PATH_MAX];
    struct stat st;
    char *slash;
    if(!summary) { store_text(err,err_size,"internal error: summary is required"); return 0; }
    memset(summary,0,sizeof(*summary));
    if(!resolve_root(state_root,root_r,sizeof(root_r),err,err_size)) return 0;
    if(!resolve_existing_within(source,root_r,source_r,sizeof(source_r),err,err_size)) return 0;
    if(lstat(dest,&st)==0) {
        /* Existing dest must be an empty directory (restore refills the
         * cleared upper); copy the source children into it. */
        DIR *dir;
        struct dirent *entry;
        int empty,ok=0;
        if(!S_ISDIR(st.st_mode)) { store_text(err,err_size,"dest exists and is not a directory"); return 0; }
        if(!resolve_existing_within(dest,root_r,parent,sizeof(parent),err,err_size)) return 0;
        if(!dir_is_empty(dest,&empty,err,err_size)) return 0;
        if(!empty) { store_text(err,err_size,"dest must be empty when it already exists"); return 0; }
        dir=opendir(source_r);
        if(!dir) { store_err(err,err_size,"cannot open source directory"); return 0; }
        while((entry=readdir(dir))!=NULL) {
            char child_source[PATH_MAX],child_dest[PATH_MAX];
            if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,"..")) continue;
            if(!join_child(child_source,sizeof(child_source),source_r,entry->d_name)||!join_child(child_dest,sizeof(child_dest),dest,entry->d_name)) {
                store_text(err,err_size,"path is too long");
                goto existing_done;
            }
            if(!copy_entry(child_source,child_dest,summary,err,err_size)) goto existing_done;
        }
        copy_xattrs(source_r,dest);
        ok=1;
existing_done:
        (void)closedir(dir);
        return ok;
    }
    if(errno!=ENOENT) { store_err(err,err_size,"cannot inspect dest"); return 0; }
    /* Create missing parents (no-follow), then prove the parent chain stays
     * inside stateRoot before the fresh dest directory is created. */
    if(strlen(dest)>=sizeof(parent)) { store_text(err,err_size,"dest path is too long"); return 0; }
    (void)strcpy(parent,dest);
    slash=strrchr(parent,'/');
    if(!slash||slash==parent) { store_text(err,err_size,"dest must be below stateRoot"); return 0; }
    *slash='\0';
    if(!ensure_dir(parent,0,err,err_size)) return 0;
    {
        /* The parent chain may be stateRoot itself (dest directly below it),
         * so check containment without the strict-below rule. */
        char *rp=realpath(parent,NULL);
        if(!rp) { store_err(err,err_size,"dest parent does not resolve"); return 0; }
        if(!owc_path_is_within(rp,root_r)) {
            free(rp);
            store_text(err,err_size,"dest resolves outside stateRoot (symlink escape refused)");
            return 0;
        }
        free(rp);
    }
    return copy_entry(source_r,dest,summary,err,err_size);
}

int owc_overlay_clear_dir(const char *state_root, const char *path,
                          char *err, size_t err_size) {
    char root_r[PATH_MAX],path_r[PATH_MAX];
    struct stat st;
    if(!resolve_root(state_root,root_r,sizeof(root_r),err,err_size)) return 0;
    if(!resolve_existing_within(path,root_r,path_r,sizeof(path_r),err,err_size)) return 0;
    if(stat(path_r,&st)!=0||!S_ISDIR(st.st_mode)) { store_text(err,err_size,"path is not a directory"); return 0; }
    return clear_children(path_r,err,err_size);
}

#else /* !__linux__ */

int owc_overlay_supported(void) { return 0; }

void owc_overlay_probe(owc_overlay_capabilities *caps) {
    if(caps) {
        caps->supported=0;
        caps->fuse_overlayfs=0;
        caps->kernel_mount=0;
    }
}

static int unsupported(char *err, size_t err_size) {
    if(err&&err_size) (void)snprintf(err,err_size,"overlay snapshot primitives are only supported on Linux");
    return 0;
}

int owc_overlay_mount(const char *state_root, const char *lower,
                      const char *upper, const char *work, const char *merged,
                      int *method, char *err, size_t err_size) {
    (void)state_root; (void)lower; (void)upper; (void)work; (void)merged; (void)method;
    return unsupported(err,err_size);
}

int owc_overlay_unmount(const char *merged, char *err, size_t err_size) {
    (void)merged;
    return unsupported(err,err_size);
}

int owc_overlay_copy_tree(const char *state_root, const char *source,
                          const char *dest, owc_overlay_copy_summary *summary,
                          char *err, size_t err_size) {
    (void)state_root; (void)source; (void)dest; (void)summary;
    return unsupported(err,err_size);
}

int owc_overlay_clear_dir(const char *state_root, const char *path,
                          char *err, size_t err_size) {
    (void)state_root; (void)path;
    return unsupported(err,err_size);
}

#endif
