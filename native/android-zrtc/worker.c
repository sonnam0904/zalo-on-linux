/* Persistent offline native worker. Binary commands on stdin; JSON replies on
 * fd 3. stdout/stderr are diagnostics, never protocol.
 * Internet and device sockets are denied until desktop signaling is integrated.
 */
#include "compat-jni.h"
#include "video-peer-linux.h"
#include "video-frame-store.h"
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <unistd.h>
#include <signal.h>
#include <unwind.h>
static _Unwind_Reason_Code trace_frame(struct _Unwind_Context *ctx, void *opaque) {
    (void)opaque;
    uintptr_t pc = _Unwind_GetIP(ctx);
    Dl_info info;
    if (dladdr((void *)pc, &info)) fprintf(stderr,"FAULT_STACK %s +0x%lx\n",
        info.dli_fname, (unsigned long)(pc - (uintptr_t)info.dli_fbase));
    return _URC_NO_REASON;
}
static void trace_abort(int signo) {
    _Unwind_Backtrace(trace_frame, NULL);
    signal(signo,SIG_DFL); raise(signo);
}
int zrtc_linux_voice_platform(void *library);
static FILE *out;
static void *lib;
static JNIEnv *env;
static int initialized, configured;
static int diagnostic_config;
static int local_pcm;
static int network_enabled;
static int cpu_video;
static int cpu_video_network;
static int64_t peer, config;
static int64_t media;
static void *native_callback;
static jobject callback;
static uint32_t call_request;
static void *sym(const char *name) {
    void *p = dlsym(lib, name);
    if (!p) { fputs("WORKER: missing native export\n", stderr); exit(2); }
    return p;
}
typedef struct { uint64_t words[3]; } NativeString;
static void string_init(NativeString *s, const void *bytes, size_t length) {
    memset(s, 0, sizeof *s);
    void *(*assign)(void *, const char *, size_t) = sym(
        "_ZNSt6__ndk112basic_stringIcNS_11char_traitsIcEENS_9allocatorIcEEE6assignEPKcm");
    assign(s, bytes, length);
}
static void string_free(NativeString *s) {
    /* Pinned x86_64 NDK string destructor is inlined in the original wrappers. */
    if (s->words[0] & 1) {
        void (*release)(void *) = sym("_ZdlPv");
        release((void *)(uintptr_t)s->words[2]);
    }
    memset(s, 0, sizeof *s);
}
static uint32_t u32(const unsigned char *p) {
    return (uint32_t)p[0] | (uint32_t)p[1]<<8 | (uint32_t)p[2]<<16 | (uint32_t)p[3]<<24;
}
static int read_all(void *p, size_t length) {
    size_t offset = 0;
    while (offset < length) {
        ssize_t n = read(0, (char *)p + offset, length - offset);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return offset ? -1 : (int)n;
        offset += (size_t)n;
    }
    return 1;
}
static void offline(void) {
    if (network_enabled) {
        /* Explicit transport mode. Keep architecture/x32 checks and disallow
           other socket families; local devices remain a separate opt-in. */
        struct sock_filter code[] = {
            BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
            BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
            BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, 0x40000000, 0, 1),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
            /* libevent requires a private socketpair for signal wakeups.
               socketpair does not connect to a local service or device. */
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 1, 0),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
            BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET, 3, 0),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_INET6, 2, 0),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_UNIX, local_pcm ? 1 : 0, 0),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        };
        struct sock_fprog program = {sizeof code / sizeof code[0], code};
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
            prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) exit(2);
        return;
    }
    if (local_pcm) {
        /* Explicit local-device mode, inherited by PCM children. No IP
           sockets can be created; stdin/protocol descriptors are pipes. */
        struct sock_filter code[] = {
            BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
            BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
            BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, 0x40000000, 0, 1),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 2, 0),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socketpair, 1, 0),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
            BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, args[0])),
            BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AF_UNIX, 1, 0),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
            BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
        };
        struct sock_fprog program = {sizeof code / sizeof code[0], code};
        if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
            prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) exit(2);
        return;
    }
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_socket, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_connect, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K, __NR_sendto, 0, 1),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {sizeof code / sizeof code[0], code};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) exit(2);
}
static void json_string(const char *s);
static void response(uint32_t id, int code, jstring data) {
    /* Take gate lock before stdout lock: a recording callback may emit events. */
    const ZrtcCaptureStats capture = zrtc_linux_audio_capture_stats();
    flockfile(out);
    fprintf(out, "{\"type\":\"response\",\"id\":%u,\"code\":%d,\"initialized\":%s,\"configured\":%s,\"callReady\":false,\"offline\":%s,\"data\":",
            id, code, initialized ? "true" : "false", configured ? "true" : "false", network_enabled ? "false" : "true");
    const char *text = data ? (*env)->GetStringUTFChars(env, data, NULL) : NULL;
    json_string(text);
    /* Pinned CallConfig layout: original JNI setter at 0x2c9b30 writes +0x2d.
       Read back native state, not a shadow of the requested option. */
    fprintf(out, ",\"enableChangeZrtp\":%s", config && ((const unsigned char *)(uintptr_t)config)[0x2d] ? "true" : "false");
    fprintf(out, ",\"videoFramesSubmitted\":%lu",linux_video_peer_frames());
    fprintf(out, ",\"captureGate\":{\"muted\":%s,\"inputNonzero\":%lu,\"outputNonzero\":%lu,\"mutedFrames\":%lu}",
        capture.muted ? "true" : "false", capture.input_nonzero, capture.output_nonzero, capture.muted_frames);
    fprintf(out, ",\"pcmFrames\":{\"recorded\":%lu,\"played\":%lu}}\n",
        zrtc_linux_audio_frames(1), zrtc_linux_audio_frames(0));
    if (data) (*env)->ReleaseStringUTFChars(env, data, text);
    if (fflush(out)) _exit(2);
    funlockfile(out);
}
static void json_string(const char *s) {
    if (!s) { fputs("null", out); return; }
    fputc('"', out);
    for (const unsigned char *p = (const unsigned char *)s; *p; p++) {
        if (*p == '"' || *p == '\\') { fputc('\\', out); fputc(*p, out); }
        else if (*p < 32) fprintf(out, "\\u%04x", *p);
        else fputc(*p, out);
    }
    fputc('"', out);
}
static void event(void *opaque, const char *name, const ZrtcEventValue *values, size_t n) {
    (void)opaque;
    flockfile(out);
    fprintf(out, "{\"type\":\"event\",\"requestId\":%u,\"event\":", __atomic_load_n(&call_request, __ATOMIC_ACQUIRE));
    json_string(name); fputs(",\"args\":[", out);
    for (size_t i = 0; i < n; i++) {
        if (i) fputc(',', out);
        if (values[i].type == 'S') json_string(values[i].string);
        else if (values[i].type == 'Z') fputs(values[i].integer ? "true" : "false", out);
        else fprintf(out, "%d", values[i].integer);
    }
    fputs("]}\n", out);
    if (fflush(out)) _exit(2);
    funlockfile(out);
}
static int64_t new_peer(void) {
    int64_t (*create)(JNIEnv *, void *) = sym("_Z24PeerJNI_zrtc_peer_createP7_JNIEnvP7_jclass");
    int64_t next = create(env, NULL);
    if (!next) exit(2);
    int (*context)(JNIEnv *, void *, int64_t, jobject) = sym("_Z33PeerJNI_zrtc_peer_set_app_contextP7_JNIEnvP7_jclasslP8_jobject");
    jobject ctx = zrtc_linux_context();
    if (context(env, NULL, next, ctx)) exit(2);
    (*env)->DeleteLocalRef(env, ctx);
    return next;
}
static void stop(void) {
    if(cpu_video)linux_video_peer_detach();
    if (local_pcm) {
        /* EARLY can start JNI streams before full RTP call startup. Stop
           those callbacks before native teardown destroys EventTimeWatcher. */
        void *record = zrtc_linux_audio_object(1), *track = zrtc_linux_audio_object(0);
        int (*stop_record)(void *) = sym("_ZN6webrtc14AudioRecordJni13StopRecordingEv");
        int (*stop_track)(void *) = sym("_ZN6webrtc13AudioTrackJni11StopPlayoutEv");
        if (record) stop_record(record);
        if (track) stop_track(track);
    }
    if (__atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) {
        void (*end)(JNIEnv *, void *, int64_t, unsigned char) = sym(
            "_Z26PeerJNI_zrtc_peer_end_callP7_JNIEnvP7_jclasslh");
        end(env, NULL, peer, 1);

    }
    void (*native_stop)(void *, unsigned char) = sym("_ZN4zrtc4Peer4stopEb");
    native_stop((void *)(uintptr_t)peer, 1);
    zrtc_linux_audio_set_muted(0);
    if (callback) {
        /* Keep our local reference until teardown. Original C1 adds exactly
           one global ref; original D1 releases it when the engine destroys
           an adopted callback. A rejected-before-adoption callback retains it. */
        unsigned refs = zrtc_linux_refs(callback);
        if (refs == 2) {
            void (*dtor)(void *) = sym("_ZN15JniCallCallbackD1Ev");
            dtor(native_callback); free(native_callback);
        } else if (refs != 1) { fputs("WORKER: unexpected callback ownership\n", stderr); _exit(2); }
        (*env)->DeleteLocalRef(env, callback);
        callback = NULL; native_callback = NULL;
    }
    initialized = 0;
    __atomic_store_n(&call_request, 0, __ATOMIC_RELEASE);
    if (diagnostic_config) {
        /* Diagnostic _initCallConfig sets isInCall without transitioning out
           of state 6. endCall(6) is then a no-op. Recreate the stopped peer
           through its public lifecycle; do not overwrite controller memory. */
        void (*destroy)(JNIEnv *, void *, int64_t) = sym("_Z24PeerJNI_zrtc_peer_deleteP7_JNIEnvP7_jclassl");
        destroy(env, NULL, peer);
        peer = new_peer();
        diagnostic_config = 0;
    }
}
static int new_callback(void) {
    native_callback = calloc(1, 0xa8);
    if (!native_callback) return -ENOMEM;
    callback = zrtc_linux_call_callback(event, NULL, 0);
    void (*ctor)(void *, jobject) = sym("_ZN15JniCallCallbackC1EP8_jobject");
    ctor(native_callback, callback);
    return 0;
}
typedef struct { const char *symbol; int kind; } Field;
static const Field fields[] = {
    {"_Z36PeerJNI_zrtc_call_config_set_user_idP7_JNIEnvP7_jclassli", 0},
    {"_Z39PeerJNI_zrtc_call_config_set_partner_idP7_JNIEnvP7_jclassli", 0},
    {"_Z37PeerJNI_zrtc_call_config_set_protocolP7_JNIEnvP7_jclassli", 0},
    {"_Z41PeerJNI_zrtc_call_config_set_zalo_call_idP7_JNIEnvP7_jclassli", 0},
    {"_Z43PeerJNI_zrtc_call_config_set_client_versionP7_JNIEnvP7_jclassli", 0},
    {"_Z36PeerJNI_zrtc_call_config_set_sessionP7_JNIEnvP7_jclasslP8_jstring", 1},
    {"_Z40PeerJNI_zrtc_call_config_set_config_jsonP7_JNIEnvP7_jclasslP8_jstring", 1},
    {"_Z45PeerJNI_zrtc_call_config_set_zrtc_config_jsonP7_JNIEnvP7_jclasslP8_jstring", 1},
    {"_Z47PeerJNI_zrtc_call_config_set_enable_change_ZRTPP7_JNIEnvP7_jclasslh", 2},
    {"_Z39PeerJNI_zrtc_call_config_set_video_callP7_JNIEnvP7_jclasslh", 2},
    {"_Z47PeerJNI_zrtc_call_config_set_support_video_callP7_JNIEnvP7_jclasslh", 2},
};
static int configure(const unsigned char *data, size_t size) {
    /* Validate the entire TLV frame before changing native configuration. */
    unsigned seen = 0;
    for (size_t offset = 0; offset < size;) {
        if (size - offset < 8) return -EINVAL;
        uint32_t field = u32(data + offset), n = u32(data + offset + 4);
        offset += 8;
        if (field >= sizeof fields / sizeof fields[0] || n > size - offset || (seen & (1u << field))) return -EINVAL;
        if ((fields[field].kind != 1 && n != 4) || (fields[field].kind == 1 && memchr(data + offset, 0, n))) return -EINVAL;
        if (fields[field].kind == 2 && u32(data + offset) > 1) return -EINVAL;
        seen |= 1u << field;
        offset += n;
    }
    if (!seen) return -EINVAL;
    int64_t (*create)(void *, void *) = sym("_Z31PeerJNI_zrtc_call_config_createP7_JNIEnvP7_jclass");
    void (*destroy)(void *, void *, int64_t) = sym("_Z31PeerJNI_zrtc_call_config_deleteP7_JNIEnvP7_jclassl");
    int64_t next = create(env, NULL);
    if (!next) return -ENOMEM;
    for (size_t offset = 0; offset < size;) {
        uint32_t field = u32(data + offset), n = u32(data + offset + 4);
        offset += 8;
        if (fields[field].kind == 1) {
            char *s = malloc((size_t)n + 1);
            if (!s) { destroy(env, NULL, next); return -ENOMEM; }
            memcpy(s, data + offset, n); s[n] = 0;
            jstring string = (*env)->NewStringUTF(env, s);
            void (*set)(JNIEnv *, void *, int64_t, jstring) = sym(fields[field].symbol);
            set(env, NULL, next, string);
            (*env)->DeleteLocalRef(env, string);
            free(s);
        } else if (fields[field].kind == 2) {
            void (*set)(JNIEnv *, void *, int64_t, jboolean) = sym(fields[field].symbol);
            set(env, NULL, next, (jboolean)u32(data + offset));
        } else {
            void (*set)(JNIEnv *, void *, int64_t, jint) = sym(fields[field].symbol);
            set(env, NULL, next, (jint)u32(data + offset));
        }
        offset += n;
    }
    destroy(env, NULL, config); config = next; configured = 1;
    return 0;
}
int main(int argc, char **argv) {
    if (argc < 2 || argc > 6) return 2;
    for (int i = 2; i < argc; i++) {
        if (!strcmp(argv[i], "--local-pcm") && !local_pcm) local_pcm = 1;
        else if (!strcmp(argv[i], "--signaling-network") && !network_enabled) network_enabled = 1;
        else if (!strcmp(argv[i], "--cpu-video") && !cpu_video) cpu_video = 1;
        else if (!strcmp(argv[i], "--cpu-video-network") && !cpu_video_network) cpu_video_network = 1;
        else return 2;
    }
    if(cpu_video_network && (!cpu_video || !network_enabled))return 2;
    if(cpu_video && network_enabled && !cpu_video_network)return 2;
    if (local_pcm && (!getenv("ZRTC_PCM_HOST") || !getenv("ZRTC_PCM_SOURCE") || !getenv("ZRTC_PCM_SINK"))) return 2;
    if (fcntl(3, F_SETFD, FD_CLOEXEC)) return 2;
    out = fdopen(3, "w");
    if (!out) return 2;
    offline();
    /* Verify IP socket denial in the actual inherited filter before loading
       the engine, rather than relying solely on the filter's source. */
    for (int i = 0; i < 2; i++) {
        errno = 0;
        int fd = socket(i ? AF_INET6 : AF_INET, SOCK_DGRAM, 0);
        if (network_enabled) { if (fd < 0) return 2; close(fd); }
        else if (fd >= 0 || errno != EPERM) return 2;
    }
    if (network_enabled) {
        int pair[2];
        if (socketpair(AF_UNIX, SOCK_STREAM, 0, pair)) return 2;
        close(pair[0]); close(pair[1]);
        if (!local_pcm) {
            errno = 0;
            int fd = socket(AF_UNIX, SOCK_STREAM, 0);
            if (fd >= 0 || errno != EPERM) return 2;
        }
    }
    lib = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!lib || (cpu_video ? linux_video_peer_install(lib) : zrtc_linux_voice_platform(lib))) return 2;
    if (getenv("ZRTC_DEBUG_BACKTRACE")) signal(SIGABRT,trace_abort);
    env = zrtc_linux_env();
    jint (*load)(JavaVM *, void *) = sym("JNI_OnLoad");
    if (load(zrtc_linux_vm(), NULL) != JNI_VERSION_1_6) return 2;
    int64_t (*create_config)(void *, void *) = sym("_Z31PeerJNI_zrtc_call_config_createP7_JNIEnvP7_jclass");
    peer = new_peer(); config = create_config(env, NULL);
    if (!peer || !config) return 2;

    int64_t (*create_media)(JNIEnv *, void *) = sym("_Z36PeerJNI_zrtc_media_codec_info_createP7_JNIEnvP7_jclass");
    media = create_media(env, NULL);
    if (!media) return 2;
    fprintf(out,"{\"type\":\"ready\",\"protocol\":1,\"offline\":%s,\"callReady\":false,\"localPcm\":%s}\n",network_enabled ? "false" : "true",local_pcm ? "true" : "false"); fflush(out);
    int result = 0;
    for (;;) {
        unsigned char header[4];
        int r = read_all(header, 4);
        if (r <= 0) { result = r < 0 ? 2 : 0; break; }
        uint32_t length = u32(header);
        if (length < 8 || length > 1024 * 1024) { result = 2; break; }
        unsigned char *frame = malloc(length);
        if (!frame) { result = 2; break; }
        if (read_all(frame, length) != 1) { free(frame); result = 2; break; }
        uint32_t id = u32(frame), op = u32(frame + 4);
        int rc = 0, quit = 0;
        jstring reply_data = NULL;
        if (op != 5 && op != 6 && op != 7 && op != 8 && op != 10 && op != 12 && op != 13 && op != 17 && length != 8) rc = -EINVAL;
        else switch (op) {
            case 1: {
                if (initialized) { rc = -EALREADY; break; }
                if (__atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) { rc = -EBUSY; break; }
                void (*init_config)(void *) = sym("_ZN4zrtc4Peer15_initZrtcConfigEv");
                int (*init)(void *) = sym("_ZN4zrtc4Peer10initializeEv");
                if (configured) {
                    diagnostic_config = 1;
                    void (*apply)(void *, void *, unsigned char, void *) = sym(
                        "_ZN4zrtc4Peer15_initCallConfigEPNS_10CallConfigEbPNS_12CallCallbackE");
                    apply((void *)(uintptr_t)peer, (void *)(uintptr_t)config, 1, NULL);
                }
                init_config((void *)(uintptr_t)peer);

                rc = init((void *)(uintptr_t)peer);
                initialized = rc == 0;
                break;
            }
            case 2: stop(); break;
            case 3: break;
            case 4: stop(); quit = 1; break;
            case 5: rc = (initialized || __atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) ?
                            -EBUSY : configure(frame + 8, length - 8); break;
            case 6: {
                if (!configured) { rc = -EINVAL; break; }
                if (initialized || __atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) { rc = -EBUSY; break; }
                size_t n = length - 8;
                if (!n || memchr(frame + 8, 0, n)) { rc = -EINVAL; break; }
                if ((rc = new_callback())) break;
                NativeString servers;
                string_init(&servers, frame + 8, n);
                unsigned char (*make)(void *, void *, void *, void *) = sym(
                    "_ZN4zrtc4Peer8makeCallEPNS_10CallConfigEPNS_12CallCallbackENSt6__ndk112basic_stringIcNS5_11char_traitsIcEENS5_9allocatorIcEEEE");
                __atomic_store_n(&call_request, id, __ATOMIC_RELEASE);
                int accepted = make((void *)(uintptr_t)peer, (void *)(uintptr_t)config, native_callback, &servers);
                string_free(&servers);
                int (*init)(void *) = sym("_ZN4zrtc4Peer10initializeEv");

                int init_result = init((void *)(uintptr_t)peer);
                initialized = init_result == 0;
                rc = !accepted ? -EIO : init_result;
                break;
            }
            case 7: {
                if (length != 12 || u32(frame + 8) > 18) { rc = -EINVAL; break; }
                if (!__atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) { rc = -ENOTCONN; break; }
                void (*receive)(JNIEnv *, void *, int64_t, jint) = sym(
                    "_Z36PeerJNI_zrtc_peer_receive_call_eventP7_JNIEnvP7_jclassli");
                receive(env, NULL, peer, (jint)u32(frame + 8));
                break;
            }
            case 8: {
                /* CPU video networking requires --cpu-video-network at startup;
                   this entry does not enable the desktop incoming UI. */
                if (!configured) { rc = -EINVAL; break; }
                if (initialized || __atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) { rc = -EBUSY; break; }
                /* Five length-prefixed strings: RTP, RTCP, relayServer,
                   partner audio codec JSON, codec extension data. */
                const unsigned char *values[5]; uint32_t sizes[5];
                size_t offset = 8;
                for (int i = 0; i < 5; i++) {
                    if (length - offset < 4) { rc = -EINVAL; break; }
                    sizes[i] = u32(frame + offset); offset += 4;
                    if (sizes[i] > length - offset || memchr(frame + offset, 0, sizes[i])) { rc = -EINVAL; break; }
                    values[i] = frame + offset; offset += sizes[i];
                }
                if (rc || offset != length) { rc = -EINVAL; break; }
                const char *setters[2] = {
                    "_Z53PeerJNI_zrtc_media_codec_info_set_audio_partner_codecP7_JNIEnvP7_jclasslP8_jstring",
                    "_Z45PeerJNI_zrtc_media_codec_info_set_extend_dataP7_JNIEnvP7_jclasslP8_jstring"};
                for (int i = 0; i < 2; i++) {
                    uint32_t n = sizes[i + 3];
                    char *text = malloc((size_t)n + 1);
                    if (!text) { rc = -ENOMEM; break; }
                    memcpy(text, values[i + 3], n); text[n] = 0;
                    jstring s = (*env)->NewStringUTF(env, text); free(text);
                    void (*set)(JNIEnv *, void *, int64_t, jstring) = sym(setters[i]);
                    set(env, NULL, media, s); (*env)->DeleteLocalRef(env, s);
                }
                if (rc) break;
                if ((rc = new_callback())) break;
                NativeString strings[3];
                for (int i = 0; i < 3; i++) string_init(&strings[i], values[i], sizes[i]);
                unsigned char (*incoming)(void *, void *, void *, void *, void *, void *, void *) = sym(
                    "_ZN4zrtc4Peer12incomingCallEPNS_10CallConfigEPNS_12CallCallbackEPNS_14MediaCodecInfoENSt6__ndk112basic_stringIcNS7_11char_traitsIcEENS7_9allocatorIcEEEESD_SD_");
                __atomic_store_n(&call_request, id, __ATOMIC_RELEASE);
                int accepted = incoming((void *)(uintptr_t)peer, (void *)(uintptr_t)config, native_callback,
                    (void *)(uintptr_t)media, &strings[0], &strings[1], &strings[2]);
                /* Stage only: never log server/session/codec payloads. */
                const int *stage = sym("_ZN4zrtc11ConstParams19sIncomingDebugStateE");
                fprintf(stderr, "WORKER: incoming accepted=%d native-stage=%d\n", accepted, *stage);
                for (int i = 0; i < 3; i++) string_free(&strings[i]);
                if (accepted) {
                    int (*init)(void *) = sym("_ZN4zrtc4Peer10initializeEv");
                    rc = init((void *)(uintptr_t)peer);
                    initialized = rc == 0;
                } else stop();
                if(!accepted)rc=-EIO;
                break;
            }
            case 9: {
                if (!initialized) { rc = -ENOTCONN; break; }
                jstring (*get)(JNIEnv *, void *, int64_t) = sym(
                    "_Z41PeerJNI_zrtc_peer_get_active_audio_codecsP7_JNIEnvP7_jclassl");
                reply_data = get(env, NULL, peer);
                break;
            }
            case 12: {
                if (!initialized || !__atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) { rc = -ENOTCONN; break; }
                const unsigned char *values[2]; uint32_t sizes[2];
                size_t offset = 8;
                for (int i = 0; i < 2; i++) {
                    if (length - offset < 4) { rc = -EINVAL; break; }
                    sizes[i] = u32(frame + offset); offset += 4;
                    if (sizes[i] > length - offset || memchr(frame + offset, 0, sizes[i])) { rc = -EINVAL; break; }
                    values[i] = frame + offset; offset += sizes[i];
                }
                if (rc || offset != length) { rc = -EINVAL; break; }
                const char *setters[2] = {
                    "_Z53PeerJNI_zrtc_media_codec_info_set_audio_partner_codecP7_JNIEnvP7_jclasslP8_jstring",
                    "_Z45PeerJNI_zrtc_media_codec_info_set_extend_dataP7_JNIEnvP7_jclasslP8_jstring"};
                char *texts[2] = {NULL, NULL};
                for (int i = 0; i < 2; i++) {
                    texts[i] = malloc((size_t)sizes[i] + 1);
                    if (!texts[i]) { rc = -ENOMEM; break; }
                    memcpy(texts[i], values[i], sizes[i]); texts[i][sizes[i]] = 0;
                }
                if (!rc) {
                    for (int i = 0; i < 2; i++) {
                        jstring s = (*env)->NewStringUTF(env, texts[i]);
                        void (*set)(JNIEnv *, void *, int64_t, jstring) = sym(setters[i]);
                        set(env, NULL, media, s); (*env)->DeleteLocalRef(env, s);
                    }
                    unsigned char (*update)(JNIEnv *, void *, int64_t, int64_t) = sym(
                        "_Z36PeerJNI_zrtc_peer_update_caller_infoP7_JNIEnvP7_jclassll");
                    rc = update(env, NULL, peer, media) ? 0 : -EIO;
                }
                free(texts[0]); free(texts[1]);
                break;
            }
            case 11: {
                if (!initialized) { rc = -ENOTCONN; break; }
                jstring (*get)(JNIEnv *, void *, int64_t) = sym(
                    "_Z33PeerJNI_zrtc_peer_get_extend_dataP7_JNIEnvP7_jclassl");
                reply_data = get(env, NULL, peer);
                break;
            }
            case 10: {
                if (length != 12 || u32(frame + 8) < 3 || u32(frame + 8) > 5) { rc = -EINVAL; break; }
                if (!initialized || !__atomic_load_n(&call_request, __ATOMIC_ACQUIRE)) { rc = -ENOTCONN; break; }
                /* EARLY/CONFIRMED start devices. This offline worker has no
                   PCM host connection yet; native fallback would exit(78). */
                if (!local_pcm && u32(frame + 8) >= 4) { rc = -ENOTSUP; break; }
                void (*set)(JNIEnv *, void *, int64_t, jint) = sym(
                    "_Z32PeerJNI_zrtc_peer_set_call_stateP7_JNIEnvP7_jclassli");
                unsigned long failures = zrtc_linux_audio_failures();
                set(env, NULL, peer, (jint)u32(frame + 8));
                if (zrtc_linux_audio_failures() != failures) { stop(); rc = -ENODEV; }
                /* JNI setter is void. code 0 means dispatched, not connected. */
                break;
            }
            case 13: {
                if(!cpu_video) {rc=-ENOTSUP;break;}
                if(!initialized || !__atomic_load_n(&call_request,__ATOMIC_ACQUIRE)) {rc=-ENOTCONN;break;}
                if(length<28) {rc=-EINVAL;break;}
                uint64_t timestamp=(uint64_t)u32(frame+20)|((uint64_t)u32(frame+24)<<32);
                if(timestamp>INT64_MAX) {rc=-EINVAL;break;}
                rc=linux_video_peer_submit(frame+28,length-28,(int)u32(frame+8),
                    (int)u32(frame+12),(int)u32(frame+16),(int64_t)timestamp);
                break;
            }
            case 17: {
                if(length!=12 || u32(frame+8)>1){rc=-EINVAL;break;}
                if(!initialized || !__atomic_load_n(&call_request,__ATOMIC_ACQUIRE)){rc=-ENOTCONN;break;}
                zrtc_linux_audio_set_muted((int)u32(frame+8));
                /* Tell the remote side: the same call Peer::mute makes after pauseRecord,
                   without touching the audio device. Offsets match the pinned libzrtc. */
                {
                    void (*set_mute_state)(void *,unsigned char)=sym("_ZN4zrtc14CallController12setMuteStateEb");
                    int call_state=*(int *)((uintptr_t)peer+0x70);
                    if(set_mute_state && (unsigned)(call_state-1)<=1u)
                        set_mute_state((void *)((uintptr_t)peer+0x8e8),(unsigned char)u32(frame+8));
                }
                break;
            }
            case 16: {
                if(length!=8){rc=-EINVAL;break;}
                if(!initialized || !__atomic_load_n(&call_request,__ATOMIC_ACQUIRE)){rc=-ENOTCONN;break;}
                jstring (*get)(JNIEnv *,void *,int64_t)=sym("_Z31PeerJNI_zrtc_peer_get_call_infoP7_JNIEnvP7_jclassl");
                reply_data=get(env,NULL,peer);
                break;
            }
            case 15: {
                if(length!=8){rc=-EINVAL;break;}
                if(!cpu_video){rc=-ENOTSUP;break;}
                const size_t capacity=1920*1080*3/2;
                unsigned char *pixels=malloc(capacity);
                if(!pixels){rc=-ENOMEM;break;}
                int width=0,height=0;uint64_t sequence=0;
                int bytes=video_frame_store_snapshot(pixels,capacity,&width,&height,&sequence);
                if(bytes<0){free(pixels);rc=bytes;break;}
                size_t encoded=4*(((size_t)bytes+2)/3);
                char *json=malloc(encoded+160);
                if(!json){memset(pixels,0,(size_t)bytes);free(pixels);rc=-ENOMEM;break;}
                size_t offset=(size_t)snprintf(json,160,"{\"format\":\"I420\",\"width\":%d,\"height\":%d,\"sequence\":\"%llu\",\"pixels\":\"",width,height,(unsigned long long)sequence);
                static const char alphabet[]="ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
                for(size_t i=0;i<(size_t)bytes;i+=3) {
                    size_t left=(size_t)bytes-i;
                    uint32_t bits=(uint32_t)pixels[i]<<16;
                    if(left>1)bits|=(uint32_t)pixels[i+1]<<8;
                    if(left>2)bits|=pixels[i+2];
                    json[offset++]=alphabet[bits>>18];json[offset++]=alphabet[(bits>>12)&63];
                    json[offset++]=left>1?alphabet[(bits>>6)&63]:'=';
                    json[offset++]=left>2?alphabet[bits&63]:'=';
                }
                json[offset++]='"';json[offset++]='}';json[offset]=0;
                reply_data=(*env)->NewStringUTF(env,json);
                memset(pixels,0,(size_t)bytes);free(pixels);
                memset(json,0,offset);free(json);
                break;
            }
            case 14: {
                if(!cpu_video) {rc=-ENOTSUP;break;}
                if(!initialized) {rc=-ENOTCONN;break;}
                void *codec;
                memcpy(&codec,(unsigned char *)(uintptr_t)peer+0x5e0,sizeof codec);
                if(!codec) {rc=-ENODEV;break;}
                int (*get_id)(void *)=sym("_ZN4zrtc4Peer11getCurCodecEv");
                void (*get_stats)(void *,int *,int *)=sym("_ZN4zrtc17WebRtcVideoCoding14GetEncodeStatsERiS1_");
                int a=0,b=0;get_stats(codec,&a,&b);
                unsigned char (*can_transfer)(void *)=sym("_ZN4zrtc4Peer19_isCanTransferMediaEv");
                unsigned char (*is_running)(void *)=sym("_ZNK3rtc14PlatformThread9IsRunningEv");
                void *capturer;memcpy(&capturer,(unsigned char *)(uintptr_t)peer+0x620,sizeof capturer);
                void *summary;memcpy(&summary,(unsigned char *)(uintptr_t)peer+0x7b0,sizeof summary);
                int (*total)(void *)=sym("_ZN4zrtc9MathStats13getTotalValueEv");
                int (*fps)(void *)=sym("_ZN4zrtc10FpsManager6getFpsEv");
                signed char (*atomic_get)(void *)=sym("_ZN4zrtc8AtomicI83getEv");
                unsigned char (*is_video)(void *)=sym("_ZN4zrtc14CallController11isVideoCallEv");
                char data[768];
                snprintf(data,sizeof data,"{\"codecId\":%d,\"nativeEncodeStat0\":%d,\"nativeEncodeStat1\":%d,\"canTransferMedia\":%s,\"captureThreadRunning\":%s,\"encodedFrames\":%lu,\"encodedBytes\":%lu,\"captureSamples\":%d,\"encodeInputSamples\":%d,\"targetFps\":%d,\"videoCall\":%s,\"videoSuspended\":%s}",
                    get_id((void *)(uintptr_t)peer),a,b,can_transfer((void *)(uintptr_t)peer)?"true":"false",
                    capturer && is_running((unsigned char *)capturer+0x1f0)?"true":"false",
                    linux_video_peer_encoded_frames(),linux_video_peer_encoded_bytes(),
                    summary?total((unsigned char *)summary+0x678):0,
                    summary?total((unsigned char *)summary+0x7b0):0,
                    fps((unsigned char *)(uintptr_t)peer+0x668),
                    is_video((unsigned char *)(uintptr_t)peer+0x8e8)?"true":"false",
                    ((unsigned char *)(uintptr_t)peer)[0xd29] && atomic_get((unsigned char *)(uintptr_t)peer+0x2990)==1?"true":"false");
                size_t used=strlen(data);
                if(used && data[used-1]=='}') snprintf(data+used-1,sizeof data-used+1,
                    ",\"decodedFrames\":%lu,\"decodedWidth\":%d,\"decodedHeight\":%d}",
                    linux_video_peer_decoded_frames(),linux_video_peer_decoded_width(),linux_video_peer_decoded_height());
                reply_data=(*env)->NewStringUTF(env,data);
                break;
            }
            default: rc = -ENOTSUP; break;
        }
        free(frame); response(id, rc, reply_data);
        if (reply_data) (*env)->DeleteLocalRef(env, reply_data);
        if (quit) break;
    }
    stop();
    void (*destroy_peer)(void *, void *, int64_t) = sym("_Z24PeerJNI_zrtc_peer_deleteP7_JNIEnvP7_jclassl");
    void (*destroy_config)(void *, void *, int64_t) = sym("_Z31PeerJNI_zrtc_call_config_deleteP7_JNIEnvP7_jclassl");
    destroy_peer(env, NULL, peer); destroy_config(env, NULL, config);
    void (*destroy_media)(JNIEnv *, void *, int64_t) = sym("_Z36PeerJNI_zrtc_media_codec_info_deleteP7_JNIEnvP7_jclassl");
    destroy_media(env, NULL, media);

    fclose(out);
    return result;
}
