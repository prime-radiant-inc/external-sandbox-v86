#define _GNU_SOURCE
#define _DARWIN_C_SOURCE
#define _FILE_OFFSET_BITS 64
#define _POSIX_C_SOURCE 200809L
#include <sys/types.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <sys/time.h>
#include <fcntl.h>
#include <unistd.h>
#include <poll.h>
#include <signal.h>
#include <termios.h>
#include <dirent.h>
#include <grp.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <limits.h>
#include <time.h>
#ifdef __linux__
#include <sys/prctl.h>
#endif

/* This protocol deliberately has no shell parser or host execution path. */
#define FRAME_MAX (1024u * 1024u)
#define TX_MAX (4u * 1024u * 1024u)
#define CONTROL_RESERVE (128u * 1024u)
#define CHUNK_MAX 49152u
#define PIPE_CHUNK 4096u
#define STDIN_MAX 65536u
#define OUTPUT_MAX (16u * 1024u * 1024u)
#define PROC_MAX 32
#define TOK_MAX 32768
#define ARG_MAX_COUNT 256
#define ENV_MAX_COUNT 256

typedef struct { char *s; size_t n, cap; int bad; } Buf;
typedef struct { char type; size_t start, end; int count, next; } Tok;
typedef struct { const char *s; size_t n, at; Tok *t; int used, bad; } Json;
typedef struct {
    int used, in, out, err, stdin_eof, reaped, status, failed;
    pid_t pid;
    uint64_t id, seq, total, kill_at, drain_at;
    unsigned char input[STDIN_MAX];
    size_t input_n;
} Proc;
static Proc procs[PROC_MAX];
static uint64_t next_process = 1;
static int transport_in = 0, transport_out = 1, root_mode;
static uid_t guest_uid = 1000;
static gid_t guest_gid = 1000;
static unsigned char tx[TX_MAX], rx[FRAME_MAX + 4];
static size_t tx_start, tx_n, rx_n;
static volatile sig_atomic_t stopped;
extern char **environ;

static uint64_t now_ms(void) {
    struct timespec t;
    clock_gettime(CLOCK_MONOTONIC, &t);
    return (uint64_t)t.tv_sec * 1000u + (unsigned)t.tv_nsec / 1000000u;
}
static void stop_signal(int sig) { (void)sig; stopped = 1; }
static void protocol_fail(const char *reason) { fprintf(stderr,"v86-agent: %s\n",reason); stopped=2; }
static void *xmalloc(size_t n) { void *p = malloc(n); if (!p) _exit(70); return p; }
static void binit(Buf *b) { memset(b, 0, sizeof(*b)); }
static void bfree(Buf *b) { free(b->s); }
static void badd(Buf *b, const char *s, size_t n) {
    if (b->bad) return;
    if (n > FRAME_MAX - b->n) { b->bad = 1; return; }
    if (b->n + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 256;
        while (cap < b->n + n + 1) cap *= 2;
        char *p = realloc(b->s, cap);
        if (!p) _exit(70);
        b->s = p; b->cap = cap;
    }
    memcpy(b->s + b->n, s, n); b->n += n; b->s[b->n] = 0;
}
static void bs(Buf *b, const char *s) { badd(b, s, strlen(s)); }
static void bf(Buf *b, const char *fmt, ...) {
    char s[256]; va_list ap; va_start(ap, fmt);
    int n = vsnprintf(s, sizeof(s), fmt, ap); va_end(ap);
    if (n < 0 || (size_t)n >= sizeof(s)) { b->bad = 1; return; }
    badd(b, s, (size_t)n);
}
static void bquote(Buf *b, const char *s) {
    bs(b, "\"");
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (*p == '"' || *p == '\\') { char c[2] = {'\\', (char)*p}; badd(b, c, 2); }
        else if (*p < 32) bf(b, "\\u%04x", *p);
        else badd(b, (const char *)p, 1);
    }
    bs(b, "\"");
}
static void queue(Buf *b) {
    if (b->bad || !b->n || b->n > FRAME_MAX || b->n + 4 > TX_MAX - tx_n) {
        protocol_fail("bounded transport queue exhausted"); return;
    }
    if (tx_start + tx_n + b->n + 4 > TX_MAX) { memmove(tx, tx + tx_start, tx_n); tx_start = 0; }
    unsigned char *p = tx + tx_start + tx_n;
    p[0] = (unsigned char)(b->n >> 24); p[1] = (unsigned char)(b->n >> 16);
    p[2] = (unsigned char)(b->n >> 8); p[3] = (unsigned char)b->n;
    memcpy(p + 4, b->s, b->n); tx_n += b->n + 4;
}
static const char *errno_code(int e) {
    switch (e) {
    case EINVAL: return "EINVAL"; case ENOENT: return "ENOENT";
    case EACCES: return "EACCES"; case EPERM: return "EPERM";
    case EEXIST: return "EEXIST"; case ENOTDIR: return "ENOTDIR";
    case EISDIR: return "EISDIR"; case ENOSPC: return "ENOSPC";
    case EAGAIN: return "EAGAIN"; case EPIPE: return "EPIPE";
    case E2BIG: return "E2BIG"; case ENOTEMPTY: return "ENOTEMPTY";
    case ELOOP: return "ELOOP"; case ENAMETOOLONG: return "ENAMETOOLONG";
    case EILSEQ: return "EILSEQ";
    case ENOEXEC: return "ENOEXEC";
    case ESRCH: return "ESRCH"; case EMFILE: return "EMFILE";
    case ENOSYS: return "ENOSYS"; default: return "EIO";
    }
}
static void error_reply(uint64_t id, const char *code, const char *message) {
    Buf b; binit(&b); bf(&b, "{\"id\":%llu,\"error\":{\"code\":", (unsigned long long)id);
    bquote(&b, code); bs(&b, ",\"message\":"); bquote(&b, message); bs(&b, "}}"); queue(&b); bfree(&b);
}
static void result_reply(uint64_t id, Buf *result) {
    if (result->bad || result->n > FRAME_MAX - 128) { error_reply(id, "E2BIG", "Result exceeds frame limit"); return; }
    Buf b; binit(&b); bf(&b, "{\"id\":%llu,\"result\":", (unsigned long long)id);
    badd(&b, result->s, result->n); bs(&b, "}"); queue(&b); bfree(&b);
}

/* Bounded recursive JSON tokenizer. Strings are decoded independently below. */
static void skip_ws(Json *j) { while (j->at < j->n && strchr(" \n\r\t", j->s[j->at])) j->at++; }
static int hex(char c) { if (c >= '0' && c <= '9') return c-'0'; if (c >= 'a' && c <= 'f') return c-'a'+10; if (c >= 'A' && c <= 'F') return c-'A'+10; return -1; }
static int parse_value(Json *j, int depth) {
    skip_ws(j);
    if (depth > 32 || j->used == TOK_MAX || j->at >= j->n) { j->bad = 1; return -1; }
    int i = j->used++; Tok *t = &j->t[i]; memset(t, 0, sizeof(*t)); t->start = j->at;
    char c = j->s[j->at++]; t->type = c;
    if (c == '{' || c == '[') {
        char end = c == '{' ? '}' : ']'; skip_ws(j);
        if (j->at < j->n && j->s[j->at] == end) j->at++;
        else for (;;) {
            if (c == '{') {
                skip_ws(j); if (j->at >= j->n || j->s[j->at] != '"') { j->bad = 1; break; }
                if (parse_value(j, depth+1) < 0) break;
                skip_ws(j); if (j->at >= j->n || j->s[j->at++] != ':') { j->bad = 1; break; }
            }
            if (parse_value(j, depth+1) < 0) break;
            t->count++; skip_ws(j);
            if (j->at >= j->n) { j->bad = 1; break; }
            c = j->s[j->at++]; if (c == end) break;
            if (c != ',') { j->bad = 1; break; }
            c = t->type;
        }
    } else if (c == '"') {
        int closed = 0;
        while (j->at < j->n) {
            unsigned char a = (unsigned char)j->s[j->at++];
            if (a == '"') { closed = 1; break; }
            if (a < 32) { j->bad = 1; break; }
            if (a == '\\') {
                if (j->at >= j->n) { j->bad = 1; break; }
                a = (unsigned char)j->s[j->at++];
                if (a == 'u') { for (int k = 0; k < 4; k++) if (j->at >= j->n || hex(j->s[j->at++]) < 0) { j->bad = 1; break; } }
                else if (!strchr("\"\\/bfnrt", a)) j->bad = 1;
            }
            if (j->bad) break;
        }
        if (!closed) j->bad = 1;
    } else {
        while (j->at < j->n && !strchr(" \n\t\r,]}", j->s[j->at])) j->at++;
        size_t len = j->at - t->start; const char *s = j->s + t->start;
        if ((len == 4 && !memcmp(s,"true",4)) || (len == 5 && !memcmp(s,"false",5)) || (len == 4 && !memcmp(s,"null",4))) {}
        else {
            size_t k = 0; if (k < len && s[k] == '-') k++;
            if (k >= len) j->bad = 1;
            else if (s[k] == '0') k++;
            else if (s[k] >= '1' && s[k] <= '9') { do { k++; } while (k < len && s[k] >= '0' && s[k] <= '9'); }
            else j->bad = 1;
            if (k < len && s[k] == '.') { k++; size_t begin = k; while (k < len && s[k] >= '0' && s[k] <= '9') k++; if (k == begin) j->bad = 1; }
            if (k < len && (s[k] == 'e' || s[k] == 'E')) { k++; if (k < len && (s[k] == '+' || s[k] == '-')) k++; size_t begin = k; while (k < len && s[k] >= '0' && s[k] <= '9') k++; if (k == begin) j->bad = 1; }
            if (k != len) j->bad = 1;
        }
    }
    t->end = j->at; t->next = j->used; return j->bad ? -1 : i;
}
static unsigned unicode4(const char *s) { unsigned n = 0; for (int i=0;i<4;i++) n = n*16u+(unsigned)hex(s[i]); return n; }
static char *jstring(Json *j, int i) {
    if (i < 0 || j->t[i].type != '"') return NULL;
    Tok *t = &j->t[i]; char *out = xmalloc(t->end-t->start); size_t n=0;
    for (size_t k=t->start+1;k<t->end-1;k++) {
        unsigned char c=(unsigned char)j->s[k];
        if (c != '\\') { out[n++]=(char)c; continue; }
        c=(unsigned char)j->s[++k];
        if (c == 'u') {
            unsigned u=unicode4(j->s+k+1); k+=4;
            if (u >= 0xd800 && u <= 0xdbff) {
                if (k+6 >= t->end || j->s[k+1] != '\\' || j->s[k+2] != 'u') { free(out); return NULL; }
                unsigned low=unicode4(j->s+k+3); if (low<0xdc00 || low>0xdfff) { free(out); return NULL; }
                u=0x10000+((u-0xd800)<<10)+(low-0xdc00); k+=6;
            } else if (u>=0xdc00 && u<=0xdfff) { free(out); return NULL; }
            if (!u) { free(out); return NULL; }
            if (u<128) out[n++]=(char)u;
            else if (u<2048) { out[n++]=(char)(0xc0|(u>>6)); out[n++]=(char)(0x80|(u&63)); }
            else if (u<65536) { out[n++]=(char)(0xe0|(u>>12)); out[n++]=(char)(0x80|((u>>6)&63)); out[n++]=(char)(0x80|(u&63)); }
            else { out[n++]=(char)(0xf0|(u>>18)); out[n++]=(char)(0x80|((u>>12)&63)); out[n++]=(char)(0x80|((u>>6)&63)); out[n++]=(char)(0x80|(u&63)); }
        } else { const char *from="bfnrt", *to="\b\f\n\r\t", *p=strchr(from,c); out[n++]=p ? to[p-from] : (char)c; }
    }
    out[n]=0; return out;
}
static int utf8_valid(const unsigned char *s) {
    while(*s) {
        unsigned c=*s++, value, count, minimum;
        if(c<128)continue;
        if(c>=0xc2&&c<=0xdf) { value=c&31; count=1; minimum=0x80; }
        else if(c>=0xe0&&c<=0xef) { value=c&15; count=2; minimum=0x800; }
        else if(c>=0xf0&&c<=0xf4) { value=c&7; count=3; minimum=0x10000; }
        else return 0;
        for(unsigned i=0;i<count;i++) { c=*s++; if(c<0x80||c>0xbf)return 0; value=(value<<6)|(c&63); }
        if(value<minimum||value>0x10ffff||(value>=0xd800&&value<=0xdfff))return 0;
    }
    return 1;
}
static int compare_strings(const void *a,const void *b) { return strcmp(*(const char *const *)a,*(const char *const *)b); }
/* Validate every string and reject duplicate keys before any mutation occurs. */
static int validate_json(Json *j) {
    for(int i=0;i<j->used;i++) {
        if(j->t[i].type=='"') { char *s=jstring(j,i); int valid=s&&utf8_valid((const unsigned char *)s); free(s); if(!valid)return 0; }
        else if(j->t[i].type=='{'&&j->t[i].count>1) {
            size_t count=(size_t)j->t[i].count; char **keys=xmalloc(count*sizeof(char *)); size_t at=0; int valid=1;
            for(int k=i+1;k<j->t[i].next;k=j->t[k+1].next) { keys[at]=jstring(j,k); if(!keys[at])valid=0; at++; }
            if(valid) { qsort(keys,count,sizeof(char *),compare_strings); for(size_t k=1;k<count;k++)if(!strcmp(keys[k-1],keys[k]))valid=0; }
            for(size_t k=0;k<count;k++)free(keys[k]);
            free(keys); if(!valid)return 0;
        }
    }
    return 1;
}
static int field(Json *j, int obj, const char *name) {
    if (obj<0 || j->t[obj].type!='{') return -1;
    int found=-1;
    for (int i=obj+1;i<j->t[obj].next;) {
        char *key=jstring(j,i); int val=i+1;
        if (!key) { j->bad=1; return -1; }
        if (!strcmp(key,name)) { if (found>=0) j->bad=1; found=val; }
        free(key); i=j->t[val].next;
    }
    return found;
}
static char *string_field(Json *j,int obj,const char *name) { return jstring(j,field(j,obj,name)); }
static int number(Json *j,int i,uint64_t *n) {
    if (i<0) return 0;
    Tok *t=&j->t[i]; if (t->start==t->end) return 0;
    uint64_t value=0;
    for(size_t k=t->start;k<t->end;k++) { char c=j->s[k]; if(c<'0'||c>'9') return 0; if(value>900719925474099u) return 0; value=value*10+(unsigned)(c-'0'); }
    if(value>9007199254740991ull) return 0;
    *n=value; return 1;
}
static int num_field(Json *j,int obj,const char *name,uint64_t fallback,uint64_t *n) { int i=field(j,obj,name); if(i<0) { *n=fallback; return 1; } return number(j,i,n); }
static int bool_field(Json *j,int obj,const char *name,int fallback,int *out) {
    int i=field(j,obj,name); if(i<0) { *out=fallback; return 1; }
    Tok *t=&j->t[i]; size_t n=t->end-t->start;
    if(n==4&&!memcmp(j->s+t->start,"true",4)) { *out=1; return 1; }
    if(n==5&&!memcmp(j->s+t->start,"false",5)) { *out=0; return 1; }
    return 0;
}
static const char b64chars[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
static void base64(Buf *b,const unsigned char *p,size_t n) {
    bs(b,"\"");
    for(size_t i=0;i<n;i+=3) { size_t left=n-i; unsigned v=(unsigned)p[i]<<16; if(left>1)v|=(unsigned)p[i+1]<<8; if(left>2)v|=p[i+2]; char s[4]={b64chars[v>>18],b64chars[(v>>12)&63],left>1?b64chars[(v>>6)&63]:'=',left>2?b64chars[v&63]:'='}; badd(b,s,4); }
    bs(b,"\"");
}
static int unbase64(const char *s,unsigned char *out,size_t *n) {
    size_t len=strlen(s),used=0; if(len%4 || len/4*3>CHUNK_MAX+2) return 0;
    for(size_t i=0;i<len;i+=4) {
        unsigned v=0; int pads=0;
        for(int k=0;k<4;k++) { const char *p=strchr(b64chars,s[i+k]); if(s[i+k]=='=') { if(k<2 || i+4!=len) return 0; pads++; v<<=6; } else { if(!p||pads) return 0; v=(v<<6)|(unsigned)(p-b64chars); } }
        if(pads>2 || (pads==1&&(v&255)) || (pads==2&&(v&65535))) return 0;
        size_t count=(size_t)(3-pads); if(used+count>CHUNK_MAX) return 0;
        out[used++]=(unsigned char)(v>>16); if(count>1)out[used++]=(unsigned char)(v>>8); if(count>2)out[used++]=(unsigned char)v;
    }
    *n=used; return 1;
}
static int set_fd(int fd) { if(fcntl(fd,F_SETFD,FD_CLOEXEC)<0)return -1; return fcntl(fd,F_SETFL,fcntl(fd,F_GETFL)|O_NONBLOCK); }
static int make_pipe(int p[2]) { if(pipe(p)<0)return -1; fcntl(p[0],F_SETFD,FD_CLOEXEC); fcntl(p[1],F_SETFD,FD_CLOEXEC); return 0; }
static void close_fd(int *fd) { if(*fd>=0)close(*fd); *fd=-1; }
static const char *kind(mode_t mode) { return S_ISREG(mode)?"file":S_ISDIR(mode)?"directory":S_ISLNK(mode)?"symlink":"other"; }
static int user_enter(void) { if(!root_mode)return 0; if(setegid(guest_gid)<0)return -1; if(seteuid(guest_uid)<0) { setegid(0); return -1; } return 0; }
static void user_leave(void) { if(root_mode&&(seteuid(0)<0||setegid(0)<0))_exit(71); }
static int valid_path(const char *p) { return p&&p[0]=='/'&&strlen(p)<PATH_MAX; }

static int mkdir_recursive(const char *path,mode_t mode) {
    char copy[PATH_MAX]; strcpy(copy,path);
    for(char *p=copy+1;*p;p++) if(*p=='/') { *p=0; if(mkdir(copy,mode)<0&&errno!=EEXIST)return -1; *p='/'; }
    if(mkdir(copy,mode)==0)return 0;
    if(errno==EEXIST) { struct stat st; if(stat(copy,&st)<0)return -1; if(S_ISDIR(st.st_mode))return 0; errno=ENOTDIR; }
    return -1;
}
/* Hold each ancestor open: concurrent rename/symlink swaps cannot redirect a request. */
static int parent_nofollow(const char *path,char leaf[PATH_MAX],int create_parents,mode_t mode) {
    char copy[PATH_MAX]; strcpy(copy,path);
    size_t length=strlen(copy); while(length>1&&copy[length-1]=='/')copy[--length]=0;
    char *last=strrchr(copy,'/'); strcpy(leaf,last[1]?last+1:"."); *last=0;
    int parent=open("/",O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if(parent<0)return -1;
    char *save=NULL;
    for(char *part=strtok_r(copy,"/",&save);part;part=strtok_r(NULL,"/",&save)) {
        int next=openat(parent,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        if(next<0&&errno==ENOENT&&create_parents) {
            if(mkdirat(parent,part,mode)<0&&errno!=EEXIST) { int e=errno; close(parent); errno=e; return -1; }
            next=openat(parent,part,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC);
        }
        if(next<0) { int e=errno; close(parent); errno=e; return -1; }
        close(parent); parent=next;
    }
    return parent;
}
/* Use *at + O_NOFOLLOW: races cannot turn a recursive walk into a link traversal. */
static int remove_at(int parent,const char *name,int recursive,int depth) {
    if(depth>64) { errno=ELOOP; return -1; }
    struct stat st; if(fstatat(parent,name,&st,AT_SYMLINK_NOFOLLOW)<0)return -1;
    if(!S_ISDIR(st.st_mode))return unlinkat(parent,name,0);
    if(!recursive)return unlinkat(parent,name,AT_REMOVEDIR);
    int fd=openat(parent,name,O_RDONLY|O_DIRECTORY|O_NOFOLLOW|O_CLOEXEC); if(fd<0)return -1;
    DIR *dir=fdopendir(fd); if(!dir) { int e=errno; close(fd); errno=e; return -1; }
    int rc=0,saved=0; struct dirent *entry;
    errno=0;
    while((entry=readdir(dir))) { if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue; if(remove_at(fd,entry->d_name,1,depth+1)<0) { rc=-1; saved=errno; break; } errno=0; }
    if(!rc&&errno) { rc=-1; saved=errno; } closedir(dir);
    if(rc) { errno=saved; return -1; } return unlinkat(parent,name,AT_REMOVEDIR);
}
static int filesystem(Json *j,int params,const char *method,Buf *out) {
    char *path=string_field(j,params,"path"); int rc=-1,parent=AT_FDCWD,follow;
    char leaf[PATH_MAX]; const char *target=path;
    if(!valid_path(path)) { free(path); errno=EINVAL; return -1; }
    if(user_enter()<0) { free(path); return -1; }
    if(!bool_field(j,params,"follow",strcmp(method,"fs.getMetadata")!=0,&follow)) { errno=EINVAL; goto done; }
    if(!follow) {
        int create=0; uint64_t mode=0755;
        if(!strcmp(method,"fs.createDirectory")&&(!bool_field(j,params,"recursive",0,&create)||!num_field(j,params,"mode",0755,&mode)||mode>0777)) { errno=EINVAL; goto done; }
        if(!strcmp(method,"fs.canonicalize")||!strcmp(method,"fs.chmod")) { errno=ENOSYS; goto done; }
        parent=parent_nofollow(path,leaf,create,(mode_t)mode); if(parent<0)goto done;
        target=leaf;
    }
    if(!strcmp(method,"fs.readFile")) {
        uint64_t offset,length;
        if(!num_field(j,params,"offset",0,&offset)||!num_field(j,params,"length",32768,&length)||length>CHUNK_MAX||offset>INT64_MAX) { errno=EINVAL; goto done; }
        int fd=openat(parent,target,O_RDONLY|O_CLOEXEC|O_NONBLOCK|(follow?0:O_NOFOLLOW)); if(fd<0)goto done;
        struct stat st; if(fstat(fd,&st)<0) { int e=errno; close(fd); errno=e; goto done; }
        if(!S_ISREG(st.st_mode)) { close(fd); errno=EINVAL; goto done; }
        unsigned char bytes[CHUNK_MAX]; ssize_t n;
        do { n=pread(fd,bytes,(size_t)length,(off_t)offset); } while(n<0&&errno==EINTR);
        int saved=errno; close(fd); errno=saved; if(n<0)goto done;
        bs(out,"{\"data\":"); base64(out,bytes,(size_t)n); bf(out,",\"eof\":%s}",offset+(uint64_t)n>=(uint64_t)st.st_size?"true":"false"); rc=0;
    } else if(!strcmp(method,"fs.writeFile")) {
        uint64_t offset,mode; int truncate;
        char *data=string_field(j,params,"data"); unsigned char bytes[CHUNK_MAX]; size_t n=0;
        int valid=data&&unbase64(data,bytes,&n)&&num_field(j,params,"offset",0,&offset)&&num_field(j,params,"mode",0644,&mode)&&mode<=0777&&bool_field(j,params,"truncate",0,&truncate)&&offset<=(uint64_t)INT64_MAX-n;
        free(data); if(!valid) { errno=EINVAL; goto done; }
        int fd=openat(parent,target,O_WRONLY|O_CREAT|O_CLOEXEC|O_NONBLOCK|(follow?0:O_NOFOLLOW),(mode_t)mode); if(fd<0)goto done;
        struct stat st; if(fstat(fd,&st)<0||!S_ISREG(st.st_mode)) { close(fd); errno=EINVAL; goto done; }
        if(truncate&&ftruncate(fd,0)<0) { int e=errno; close(fd); errno=e; goto done; }
        size_t written=0;
        while(written<n) { ssize_t count=pwrite(fd,bytes+written,n-written,(off_t)(offset+written)); if(count<0&&errno==EINTR)continue; if(count<=0) { int e=count?errno:EIO; close(fd); errno=e; goto done; } written+=(size_t)count; }
        if(close(fd)<0)goto done;
        bf(out,"{\"written\":%zu}",written); rc=0;
    } else if(!strcmp(method,"fs.createDirectory")) {
        uint64_t mode; int recursive;
        if(!num_field(j,params,"mode",0755,&mode)||mode>0777||!bool_field(j,params,"recursive",0,&recursive)) { errno=EINVAL; goto done; }
        if(follow)rc=recursive?mkdir_recursive(path,(mode_t)mode):mkdir(path,(mode_t)mode);
        else {
            rc=mkdirat(parent,target,(mode_t)mode);
            if(rc<0&&errno==EEXIST&&recursive) { struct stat st; if(fstatat(parent,target,&st,AT_SYMLINK_NOFOLLOW)==0) { if(S_ISDIR(st.st_mode))rc=0; else errno=ENOTDIR; } }
        }
        if(!rc)bs(out,"{}");
    } else if(!strcmp(method,"fs.getMetadata")) {
        struct stat st; rc=fstatat(parent,target,&st,follow?0:AT_SYMLINK_NOFOLLOW);
        if(!rc)bf(out,"{\"kind\":\"%s\",\"size\":%llu,\"mode\":%u,\"mtimeMs\":%lld}",kind(st.st_mode),(unsigned long long)st.st_size,(unsigned)(st.st_mode&0777),(long long)st.st_mtime*1000);
    } else if(!strcmp(method,"fs.canonicalize")) {
        char resolved[PATH_MAX]; if(!realpath(path,resolved))goto done;
        if(!utf8_valid((const unsigned char *)resolved)) { errno=EILSEQ; goto done; }
        bs(out,"{\"path\":"); bquote(out,resolved); bs(out,"}"); rc=0;
    } else if(!strcmp(method,"fs.readDirectory")) {
        int fd=openat(parent,target,O_RDONLY|O_DIRECTORY|O_CLOEXEC|(follow?0:O_NOFOLLOW)); if(fd<0)goto done;
        DIR *dir=fdopendir(fd); if(!dir) { int e=errno; close(fd); errno=e; goto done; }
        int count=0,fail=0; struct dirent *entry;
        bs(out,"{\"entries\":["); errno=0;
        while((entry=readdir(dir))) {
            if(!strcmp(entry->d_name,".")||!strcmp(entry->d_name,".."))continue;
            if(!utf8_valid((const unsigned char *)entry->d_name)) { fail=EILSEQ; break; }
            struct stat st; if(fstatat(dirfd(dir),entry->d_name,&st,AT_SYMLINK_NOFOLLOW)<0) { fail=errno; break; }
            if(count++)bs(out,",");
            bs(out,"{\"name\":"); bquote(out,entry->d_name); bf(out,",\"kind\":\"%s\"}",kind(st.st_mode));
            if(out->bad) { fail=E2BIG; break; } errno=0;
        }
        if(!fail&&errno)fail=errno;
        closedir(dir); if(fail) { errno=fail; goto done; }
        bs(out,"]}"); rc=0;
    } else if(!strcmp(method,"fs.remove")) {
        int recursive;
        if(!bool_field(j,params,"recursive",0,&recursive)) { errno=EINVAL; goto done; }
        size_t n=strlen(path); while(n>1&&path[n-1]=='/')path[--n]=0;
        char resolved[PATH_MAX]; struct stat st;
        if(lstat(path,&st)==0&&S_ISDIR(st.st_mode)&&realpath(path,resolved)&&!strcmp(resolved,"/")) { errno=EPERM; goto done; }
        const char *last=strrchr(path,'/'); if(!last||!strcmp(last+1,".")||!strcmp(last+1,"..")||!last[1]) { errno=EINVAL; goto done; }
        rc=remove_at(parent,target,recursive,0); if(!rc)bs(out,"{}");
    } else if(!strcmp(method,"fs.chmod")) {
        uint64_t mode;
        if(!num_field(j,params,"mode",UINT64_MAX,&mode)||mode>0777) { errno=EINVAL; goto done; }
        rc=chmod(path,(mode_t)mode); if(!rc)bs(out,"{}");
    } else errno=ENOSYS;
done: { int saved=errno; if(parent>=0)close(parent); user_leave(); free(path); errno=saved; return rc; }
}

static void process_error(Proc *p,const char *code,const char *message) {
    if(p->failed)return;
    p->failed=1;
    Buf b; binit(&b); bf(&b,"{\"event\":\"process.error\",\"processId\":\"%llu\",\"code\":",(unsigned long long)p->id);
    bquote(&b,code); bs(&b,",\"message\":"); bquote(&b,message); bs(&b,"}"); queue(&b); bfree(&b);
}
static void terminate_process(Proc *p) { if(!p->kill_at) { kill(-p->pid,SIGTERM); p->kill_at=now_ms()+1000; } close_fd(&p->in); p->input_n=0; }
static Proc *get_process(Json *j,int params) {
    char *id=string_field(j,params,"processId"); if(!id)return NULL;
    Proc *found=NULL; char text_id[32];
    for(int i=0;i<PROC_MAX;i++)if(procs[i].used) { snprintf(text_id,sizeof(text_id),"%llu",(unsigned long long)procs[i].id); if(!strcmp(id,text_id)) { found=&procs[i]; break; } }
    free(id); return found;
}
static void free_strings(char **strings) { if(strings) { for(int i=0;strings[i];i++)free(strings[i]); free(strings); } }
/* execvp may silently invoke a shell for ENOEXEC. Direct execve never does. */
static void exec_argv(const char *executable,char *const argv[]) {
    if(strchr(executable,'/')) { execve(executable,argv,environ); return; }
    const char *path=getenv("PATH"); if(!path)path="/usr/bin:/bin";
    size_t name_length=strlen(executable); int denied=0;
    for(const char *part=path;;) {
        const char *end=strchr(part,':'); size_t length=end?(size_t)(end-part):strlen(part);
        if(length+name_length+2<=PATH_MAX) {
            char candidate[PATH_MAX]; size_t at=0;
            if(length) { memcpy(candidate,part,length); at=length; candidate[at++]='/'; }
            memcpy(candidate+at,executable,name_length+1); execve(candidate,argv,environ);
            if(errno==EACCES)denied=1;
            else if(errno!=ENOENT&&errno!=ENOTDIR)return;
        }
        if(!end)break;
        part=end+1;
    }
    errno=denied?EACCES:ENOENT;
}
static int start_process(Json *j,int params,Buf *out) {
    int slot=-1; for(int i=0;i<PROC_MAX;i++)if(!procs[i].used) { slot=i; break; }
    if(slot<0) { errno=EAGAIN; return -1; }
    int args=field(j,params,"argv"),env=field(j,params,"env"),has_stdin,env_replace;
    if(args<0||j->t[args].type!='['||!j->t[args].count||j->t[args].count>ARG_MAX_COUNT||!bool_field(j,params,"stdin",1,&has_stdin)) { errno=EINVAL; return -1; }
    if((env>=0&&(j->t[env].type!='{'||j->t[env].count>ENV_MAX_COUNT))||!bool_field(j,params,"envReplace",0,&env_replace)) { errno=EINVAL; return -1; }
    char **argv=calloc((size_t)j->t[args].count+1,sizeof(char *));
    char **envs=calloc((size_t)(env>=0?j->t[env].count:0)+1,sizeof(char *));
    char *cwd=string_field(j,params,"cwd"),*arg0=string_field(j,params,"arg0"); int argc=0,envc=0,rc=-1;
    if(!argv||!envs)_exit(70);
    if(!cwd&&field(j,params,"cwd")<0)cwd=strdup("/workspace");
    if(!valid_path(cwd)||(field(j,params,"arg0")>=0&&!arg0)) { errno=EINVAL; goto done; }
    for(int i=args+1;i<j->t[args].next;i=j->t[i].next) { argv[argc]=jstring(j,i); if(!argv[argc]) { errno=EINVAL; goto done; } argc++; }
    if(!argv[0][0]) { errno=EINVAL; goto done; }
    if(env>=0)for(int i=env+1;i<j->t[env].next;) {
        char *key=jstring(j,i),*value=jstring(j,i+1);
        if(!key||!value||!key[0]||strchr(key,'=')) { free(key); free(value); errno=EINVAL; goto done; }
        size_t n=strlen(key)+strlen(value)+2; envs[envc]=xmalloc(n); snprintf(envs[envc++],n,"%s=%s",key,value); free(key); free(value); i=j->t[i+1].next;
    }
    if(j->bad) { errno=EINVAL; goto done; }
    int pin[2]={-1,-1},pout[2]={-1,-1},perr[2]={-1,-1},pexec[2]={-1,-1};
    if(make_pipe(pin)<0||make_pipe(pout)<0||make_pipe(perr)<0||make_pipe(pexec)<0)goto pipes_done;
    pid_t pid=fork(); if(pid<0)goto pipes_done;
    if(pid==0) {
        int child_error=0;
        close(pexec[0]); signal(SIGPIPE,SIG_DFL); signal(SIGTERM,SIG_DFL); signal(SIGINT,SIG_DFL);
        if(setpgid(0,0)<0)goto child_fail;
        if(dup2(pin[0],0)<0||dup2(pout[1],1)<0||dup2(perr[1],2)<0)goto child_fail;
        close(pin[0]); close(pin[1]); close(pout[0]); close(pout[1]); close(perr[0]); close(perr[1]);
        if(root_mode&&(setgroups(0,NULL)<0||setgid(guest_gid)<0||setuid(guest_uid)<0))goto child_fail;
        if(chdir(cwd)<0)goto child_fail;
        environ=calloc(1,sizeof(char *)); if(!environ)goto child_fail;
        const char *keys[]={"PATH","HOME","LANG","LC_ALL","USER","LOGNAME","SHELL"};
        const char *values[]={"/usr/local/bin:/usr/bin:/bin","/home/agent","C.UTF-8","C.UTF-8","agent","agent","/bin/sh"};
        if(!env_replace)for(size_t i=0;i<sizeof(keys)/sizeof(keys[0]);i++)if(setenv(keys[i],values[i],1)<0)goto child_fail;
        for(int i=0;i<envc;i++)if(putenv(envs[i])<0)goto child_fail;
        char *executable=argv[0]; if(arg0)argv[0]=arg0;
        exec_argv(executable,argv);
child_fail:
        child_error=errno; while(write(pexec[1],&child_error,sizeof(child_error))<0&&errno==EINTR) {} _exit(127);
    }
    setpgid(pid,pid); close_fd(&pexec[1]); close_fd(&pin[0]); close_fd(&pout[1]); close_fd(&perr[1]);
    int child_error=0; ssize_t count; do { count=read(pexec[0],&child_error,sizeof(child_error)); } while(count<0&&errno==EINTR);
    close_fd(&pexec[0]);
    if(count!=0) { if(count<0)child_error=errno; kill(-pid,SIGKILL); while(waitpid(pid,NULL,0)<0&&errno==EINTR) {} errno=child_error?child_error:EIO; goto pipes_done; }
    Proc *p=&procs[slot]; memset(p,0,sizeof(*p)); p->used=1; p->id=next_process++; p->pid=pid; p->in=pin[1]; p->out=pout[0]; p->err=perr[0];
    if(set_fd(p->in)<0||set_fd(p->out)<0||set_fd(p->err)<0) { int e=errno; kill(-pid,SIGKILL); close_fd(&p->in); close_fd(&p->out); close_fd(&p->err); p->used=0; errno=e; goto done; }
    if(!has_stdin)close_fd(&p->in);
    bf(out,"{\"processId\":\"%llu\",\"pid\":%ld}",(unsigned long long)p->id,(long)p->pid); rc=0; goto done;
pipes_done: { int e=errno; for(int i=0;i<2;i++) { close_fd(&pin[i]); close_fd(&pout[i]); close_fd(&perr[i]); close_fd(&pexec[i]); } errno=e; }
done: { int e=errno; free_strings(argv); free_strings(envs); free(cwd); free(arg0); errno=e; return rc; }
}

static void handle_message(const char *message,size_t n) {
    Tok *tokens=xmalloc(sizeof(Tok)*TOK_MAX); Json j={message,n,0,tokens,0,0};
    if(memchr(message,0,n)||parse_value(&j,0)<0||!validate_json(&j)) { free(tokens); protocol_fail("malformed JSON frame"); return; }
    skip_ws(&j);
    uint64_t id=0; int params=field(&j,0,"params"); char *method=string_field(&j,0,"method");
    if(j.at!=n||j.t[0].type!='{'||!number(&j,field(&j,0,"id"),&id)||!method||params<0||j.t[params].type!='{'||j.bad) { free(method); free(tokens); protocol_fail("invalid request envelope"); return; }
    Buf result; binit(&result); int rc=-1;
    if(!strcmp(method,"hello")) { uint64_t version; if(!num_field(&j,params,"version",0,&version)||version!=1)errno=EINVAL; else { bs(&result,"{\"version\":1}"); rc=0; } }
    else if(!strcmp(method,"process.start"))rc=start_process(&j,params,&result);
    else if(!strcmp(method,"process.shutdown")) { for(int i=0;i<PROC_MAX;i++)if(procs[i].used)terminate_process(&procs[i]); bs(&result,"{}"); rc=0; }
    else if(!strcmp(method,"process.status")) { int active=0; for(int i=0;i<PROC_MAX;i++)active+=procs[i].used; bf(&result,"{\"active\":%d}",active); rc=0; }
    else if(!strncmp(method,"process.",8)) {
        Proc *p=get_process(&j,params);
        if(!p)errno=ESRCH;
        else if(!strcmp(method,"process.write")) {
            char *data=string_field(&j,params,"data"); unsigned char bytes[CHUNK_MAX]; size_t length=0;
            if(!data||!unbase64(data,bytes,&length))errno=EINVAL;
            else if(p->in<0||p->stdin_eof)errno=EPIPE;
            else if(length>STDIN_MAX-p->input_n)errno=EAGAIN;
            else { memcpy(p->input+p->input_n,bytes,length); p->input_n+=length; bf(&result,"{\"written\":%zu}",length); rc=0; }
            free(data);
        } else if(!strcmp(method,"process.closeStdin")) { p->stdin_eof=1; if(!p->input_n)close_fd(&p->in); bs(&result,"{}"); rc=0; }
        else if(!strcmp(method,"process.terminate")) { terminate_process(p); bs(&result,"{}"); rc=0; }
        else if(!strcmp(method,"process.signal")) {
            uint64_t sig;
            if(!num_field(&j,params,"signal",0,&sig)||(sig!=2&&sig!=15&&sig!=9))errno=EINVAL;
            else { rc=kill(-p->pid,(int)sig); if(!rc)bs(&result,"{}"); }
        } else errno=ENOSYS;
    } else if(!strncmp(method,"fs.",3))rc=filesystem(&j,params,method,&result);
    else errno=ENOSYS;
    int saved=errno;
    if(j.bad)error_reply(id,"EINVAL","Duplicate or invalid object field");
    else if(rc<0)error_reply(id,errno_code(saved),strerror(saved));
    else result_reply(id,&result);
    bfree(&result); free(method); free(tokens);
}
static void read_transport(void) {
    if(rx_n==sizeof(rx)) { protocol_fail("input frame buffer exhausted"); return; }
    ssize_t n=read(transport_in,rx+rx_n,sizeof(rx)-rx_n);
    if(n==0) { stopped=1; return; }
    if(n<0) { if(errno!=EAGAIN&&errno!=EINTR)stopped=1; return; }
    rx_n+=(size_t)n;
    while(rx_n>=4&&!stopped) {
        size_t length=((size_t)rx[0]<<24)|((size_t)rx[1]<<16)|((size_t)rx[2]<<8)|rx[3];
        if(!length||length>FRAME_MAX) { protocol_fail("invalid frame length"); return; }
        if(rx_n<length+4)return;
        handle_message((const char *)rx+4,length); rx_n-=length+4; memmove(rx,rx+length+4,rx_n);
    }
}
static void write_transport(void) {
    if(!tx_n)return;
    ssize_t n=write(transport_out,tx+tx_start,tx_n>32768?32768:tx_n);
    if(n>0) { tx_start+=(size_t)n; tx_n-=(size_t)n; if(!tx_n)tx_start=0; }
    else if(n<0&&errno!=EAGAIN&&errno!=EINTR)stopped=1;
}
static void read_output(Proc *p,int is_stderr) {
    int *fd=is_stderr?&p->err:&p->out; unsigned char bytes[PIPE_CHUNK];
    ssize_t n=read(*fd,bytes,sizeof(bytes));
    if(n==0) { close_fd(fd); return; }
    if(n<0) { if(errno!=EAGAIN&&errno!=EINTR) { process_error(p,"EIO","Output pipe read failed"); close_fd(fd); terminate_process(p); } return; }
    if((uint64_t)n>OUTPUT_MAX-p->total) { process_error(p,"E2BIG","Process exceeded 16 MiB output limit"); terminate_process(p); kill(-p->pid,SIGKILL); close_fd(&p->out); close_fd(&p->err); return; }
    p->total+=(uint64_t)n;
    Buf b; binit(&b); bf(&b,"{\"event\":\"process.output\",\"processId\":\"%llu\",\"stream\":\"%s\",\"seq\":%llu,\"data\":",(unsigned long long)p->id,is_stderr?"stderr":"stdout",(unsigned long long)p->seq++);
    base64(&b,bytes,(size_t)n); bs(&b,"}"); queue(&b); bfree(&b);
}
static void write_stdin(Proc *p) {
    if(!p->input_n)return;
    ssize_t n=write(p->in,p->input,p->input_n);
    if(n>0) { p->input_n-=(size_t)n; memmove(p->input,p->input+n,p->input_n); if(!p->input_n&&p->stdin_eof)close_fd(&p->in); }
    else if(n<0&&errno!=EAGAIN&&errno!=EINTR) { process_error(p,"EPIPE","Process closed stdin before accepted input drained"); close_fd(&p->in); p->input_n=0; }
}
static void reap_processes(void) {
    uint64_t now=now_ms();
    int status; pid_t child;
    while((child=waitpid(-1,&status,WNOHANG))>0) {
        for(int i=0;i<PROC_MAX;i++)if(procs[i].used&&procs[i].pid==child) {
            Proc *p=&procs[i]; p->reaped=1; p->status=status; p->drain_at=now+2000;
            if(p->input_n)process_error(p,"EPIPE","Process exited before accepted stdin drained");
            terminate_process(p); break;
        }
    }
    for(int i=0;i<PROC_MAX;i++) {
        Proc *p=&procs[i]; if(!p->used)continue;
        if(p->kill_at&&now>=p->kill_at) { kill(-p->pid,SIGKILL); p->kill_at=UINT64_MAX; }
        if(p->reaped&&now>=p->drain_at&&(p->out>=0||p->err>=0)) { process_error(p,"ETIMEDOUT","Output pipes did not close within the drain deadline"); kill(-p->pid,SIGKILL); close_fd(&p->out); close_fd(&p->err); }
        if(p->reaped&&p->out<0&&p->err<0) {
            kill(-p->pid,SIGKILL); close_fd(&p->in);
            if(kill(-p->pid,0)==0||errno!=ESRCH)continue;
            Buf b; binit(&b); bf(&b,"{\"event\":\"process.exited\",\"processId\":\"%llu\",\"exitCode\":",(unsigned long long)p->id);
            if(WIFEXITED(p->status))bf(&b,"%d,\"signal\":null}",WEXITSTATUS(p->status)); else bf(&b,"null,\"signal\":%d}",WIFSIGNALED(p->status)?WTERMSIG(p->status):SIGKILL);
            queue(&b); b.n=0; bf(&b,"{\"event\":\"process.closed\",\"processId\":\"%llu\"}",(unsigned long long)p->id); queue(&b); bfree(&b); p->used=0;
        }
    }
}
int main(int argc,char **argv) {
    signal(SIGPIPE,SIG_IGN); signal(SIGTERM,stop_signal); signal(SIGINT,stop_signal); umask(0022);
    root_mode=getuid()==0;
#ifdef __linux__
    if(prctl(PR_SET_CHILD_SUBREAPER,1,0,0,0)<0) { perror("subreaper"); return 1; }
#endif
    if(root_mode&&setgroups(0,NULL)<0) { perror("setgroups"); return 1; }
    if(argc==3&&!strcmp(argv[1],"--device")) {
        int fd=open(argv[2],O_RDWR|O_NOCTTY|O_CLOEXEC); if(fd<0) { perror("agent device"); return 1; }
        struct termios config; if(tcgetattr(fd,&config)<0) { perror("tcgetattr"); return 1; }
        cfmakeraw(&config); config.c_cflag|=CLOCAL|CREAD; cfsetispeed(&config,B115200); cfsetospeed(&config,B115200);
        if(tcsetattr(fd,TCSANOW,&config)<0) { perror("tcsetattr"); return 1; }
        transport_in=transport_out=fd;
    } else if(argc!=1&&(argc!=2||strcmp(argv[1],"--stdio"))) { fprintf(stderr,"Usage: v86-agent [--stdio | --device /dev/ttyS1]\n"); return 2; }
    if(set_fd(transport_in)<0||set_fd(transport_out)<0) { perror("transport flags"); return 1; }
    Buf ready; binit(&ready); bs(&ready,"{\"event\":\"ready\",\"version\":1}"); queue(&ready); bfree(&ready);
    while(!stopped) {
        struct pollfd fds[2+PROC_MAX*3]; int slots[2+PROC_MAX*3],which[2+PROC_MAX*3]; nfds_t count=0;
        fds[count]=(struct pollfd){transport_in,POLLIN,0}; slots[count]=-1; which[count++]=0;
        fds[count]=(struct pollfd){transport_out,tx_n?POLLOUT:0,0}; slots[count]=-1; which[count++]=1;
        for(int i=0;i<PROC_MAX;i++)if(procs[i].used) {
            Proc *p=&procs[i];
            if(p->in>=0&&p->input_n) { fds[count]=(struct pollfd){p->in,POLLOUT,0}; slots[count]=i; which[count++]=2; }
            if(tx_n<TX_MAX-CONTROL_RESERVE) {
                if(p->out>=0) { fds[count]=(struct pollfd){p->out,POLLIN,0}; slots[count]=i; which[count++]=3; }
                if(p->err>=0) { fds[count]=(struct pollfd){p->err,POLLIN,0}; slots[count]=i; which[count++]=4; }
            }
        }
        int n=poll(fds,count,25); if(n<0) { if(errno==EINTR)continue; break; }
        for(nfds_t k=0;k<count&&!stopped;k++)if(fds[k].revents) {
            if(slots[k]<0) { if(which[k]==0)read_transport(); else write_transport(); }
            else { Proc *p=&procs[slots[k]]; if(which[k]==2) { if(p->in>=0)write_stdin(p); } else if(tx_n<TX_MAX-CONTROL_RESERVE) { if(which[k]==3&&p->out>=0)read_output(p,0); if(which[k]==4&&p->err>=0)read_output(p,1); } }
        }
        reap_processes();
    }
    for(int i=0;i<PROC_MAX;i++)if(procs[i].used)kill(-procs[i].pid,SIGKILL);
    for(int i=0;i<PROC_MAX;i++)if(procs[i].used)while(waitpid(procs[i].pid,NULL,0)<0&&errno==EINTR) {}
    return stopped==2?1:0;
}
