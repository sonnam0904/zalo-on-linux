/* Offline integration diagnostic. Never sends a call or uses account data. */
#include <dlfcn.h>
#include <errno.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <sys/socket.h>
#include <unistd.h>
#include <string.h>
#include "compat-jni.h"
int zrtc_probe_callbacks(void *lib);
int zrtc_linux_voice_platform(void *lib);

static void *sym(void *h, const char *name) {
    void *p = dlsym(h, name);
    if (!p) { fprintf(stderr, "%s\n", dlerror()); exit(2); }
    return p;
}

static void no_network(void) {
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_connect, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendto, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_sendmsg, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = { sizeof code / sizeof code[0], code };
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) {
        perror("no-network filter"); exit(2);
    }
}

static void unix_only(void) {
    /* PCM helpers need the local Pulse socket. No Internet sockets allowed. */
    struct sock_filter code[] = {
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, arch)),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AUDIT_ARCH_X86_64, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, nr)),
        BPF_JUMP(BPF_JMP | BPF_JSET | BPF_K, 0x40000000, 0, 1),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socket, 2, 0),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, __NR_socketpair, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
        BPF_STMT(BPF_LD | BPF_W | BPF_ABS, offsetof(struct seccomp_data, args[0])),
        BPF_JUMP(BPF_JMP | BPF_JEQ | BPF_K, AF_UNIX, 1, 0),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ERRNO | EPERM),
        BPF_STMT(BPF_RET | BPF_K, SECCOMP_RET_ALLOW),
    };
    struct sock_fprog program = {sizeof code / sizeof code[0], code};
    if (prctl(PR_SET_NO_NEW_PRIVS, 1, 0, 0, 0) ||
        prctl(PR_SET_SECCOMP, SECCOMP_MODE_FILTER, &program)) { perror("unix-only filter"); exit(2); }
}

static int exercise_audio(void *library) {
    void *track = zrtc_linux_audio_object(0), *record = zrtc_linux_audio_object(1);
    if (!track || !record) return -1;
    int (*init_track)(void *) = sym(library, "_ZN6webrtc13AudioTrackJni11InitPlayoutEv");
    int (*init_record)(void *) = sym(library, "_ZN6webrtc14AudioRecordJni13InitRecordingEv");
    int (*start_track)(void *) = sym(library, "_ZN6webrtc13AudioTrackJni12StartPlayoutEv");
    int (*start_record)(void *) = sym(library, "_ZN6webrtc14AudioRecordJni14StartRecordingEv");
    int (*stop_track)(void *) = sym(library, "_ZN6webrtc13AudioTrackJni11StopPlayoutEv");
    int (*stop_record)(void *) = sym(library, "_ZN6webrtc14AudioRecordJni13StopRecordingEv");
    for (int cycle = 1; cycle <= 3; cycle++) {
        unsigned long before_record = zrtc_linux_audio_frames(1), before_play = zrtc_linux_audio_frames(0);
        int rc = init_track(track) || init_record(record) || start_track(track) || start_record(record);
        if (!rc) usleep(1000000);
        int sr = stop_record(record), st = stop_track(track);
        unsigned long captured = zrtc_linux_audio_frames(1) - before_record;
        unsigned long played = zrtc_linux_audio_frames(0) - before_play;
        printf("ENGINE_PCM: cycle=%d recorded=%lu played=%lu start=%d stop=%d/%d\n", cycle, captured, played, rc, sr, st);
        if (rc || sr || st || captured < 10 || played < 10) return -1;
    }
    return 0;
}

int main(int argc, char **argv) {
    if (argc != 2 && argc != 3) return 2;
    setbuf(stdout, NULL);
    int voice_pcm = argc == 3 && !strcmp(argv[2], "--compat-voice-pcm");
    int pcm = voice_pcm || (argc == 3 && !strcmp(argv[2], "--compat-pcm"));
    int voice = voice_pcm || (argc == 3 && !strcmp(argv[2], "--compat-voice"));
    if (pcm) {
        const char *sink = getenv("ZRTC_PCM_SINK"), *source = getenv("ZRTC_PCM_SOURCE");
        if (!sink || strncmp(sink, "zrtc_native_test_", 17) || !source ||
            strncmp(source, sink, strlen(sink)) || strcmp(source + strlen(sink), ".monitor")) return 2;
        unix_only();
    } else no_network();
    alarm(10);
    void *h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!h) { fprintf(stderr, "%s\n", dlerror()); return 2; }
    if (voice && zrtc_linux_voice_platform(h)) return 2;
    int64_t (*new_peer)(void *, void *) = sym(h, "_Z24PeerJNI_zrtc_peer_createP7_JNIEnvP7_jclass");
    int64_t (*new_config)(void *, void *) = sym(h, "_Z31PeerJNI_zrtc_call_config_createP7_JNIEnvP7_jclass");
    void (*free_peer)(void *, void *, int64_t) = sym(h, "_Z24PeerJNI_zrtc_peer_deleteP7_JNIEnvP7_jclassl");
    void (*free_config)(void *, void *, int64_t) = sym(h, "_Z31PeerJNI_zrtc_call_config_deleteP7_JNIEnvP7_jclassl");
    /* Verified x86_64 NDK libc++ ABI: nontrivial string argument is passed
       indirectly; empty short-string representation is 24 zero bytes. */
    unsigned char (*make_call)(void *, void *, void *, const void *) = sym(h,
        "_ZN4zrtc4Peer8makeCallEPNS_10CallConfigEPNS_12CallCallbackENSt6__ndk112basic_stringIcNS5_11char_traitsIcEENS5_9allocatorIcEEEE");
    int64_t peer = new_peer(NULL, NULL), config = new_config(NULL, NULL);
    int pcm_failed = 0;
    if (!peer || !config) return 3;
    if (argc == 3 && (voice || pcm || !strcmp(argv[2], "--compat-callbacks") || !strcmp(argv[2], "--compat-jni") || !strcmp(argv[2], "--compat-audio"))) {
        JNIEnv *env = zrtc_linux_env();
        jint (*on_load)(JavaVM *, void *) = sym(h, "JNI_OnLoad");
        jint version = on_load(zrtc_linux_vm(), NULL);
        printf("BOUNDARY: JNI_OnLoad returned 0x%x\n", version);
        if (version != JNI_VERSION_1_6) return 78;
        int (*set_context)(void *, void *, int64_t, void *) = sym(h,
            "_Z33PeerJNI_zrtc_peer_set_app_contextP7_JNIEnvP7_jclasslP8_jobject");
        int rc = set_context(env, NULL, peer, zrtc_linux_context());
        printf("BOUNDARY: setAndroidContext via native JNI adapter returned %d\n", rc);
        if (voice) {
            int (*initialize)(void *) = sym(h, "_ZN4zrtc4Peer10initializeEv");
            if (initialize((void *)(uintptr_t)peer) != -10) return 79;
            puts("PASS non-audio mode still requires EGL");
            void (*config_init)(void *) = sym(h, "_ZN4zrtc4Peer15_initZrtcConfigEv");
            puts("BOUNDARY: native config selects voice mode and initializes engine");
            config_init((void *)(uintptr_t)peer);
            unsigned char (*audio_only)(void *) = sym(h, "_ZN4zrtc4Peer14_modeAudioOnlyEv");
            if (!audio_only((void *)(uintptr_t)peer)) return 79;
        }
        if (!strcmp(argv[2], "--compat-callbacks") && zrtc_probe_callbacks(h)) return 79;
        if (pcm || !strcmp(argv[2], "--compat-audio")) {
            void (*peer_init)(void *) = sym(h, "_ZN4zrtc4Peer5_initEv");
            void (*audio_init)(void *) = sym(h, "_ZN4zrtc4Peer16_initAudioDeviceEv");
            puts(voice ? "BOUNDARY: exercising audio in the initialized voice engine" :
                         "BOUNDARY: initializing native audio device independently of video/EGL");
            if (!voice) {
                peer_init((void *)(uintptr_t)peer);
                audio_init((void *)(uintptr_t)peer);
            }
            if (pcm) pcm_failed = exercise_audio(h) != 0;
            if (pcm && !pcm_failed) puts("PASS engine JNI PCM callbacks (isolated sink, no call)");
        }
    }
    int (*initialize)(void *) = sym(h, "_ZN4zrtc4Peer10initializeEv");
    int init_result = initialize((void *)(uintptr_t)peer);
    printf("BOUNDARY: Peer::initialize returned %d\n", init_result);
    uint64_t empty_string[3] = {0};
    puts("BOUNDARY: entering native Peer::makeCall; network denied; empty offline config");
    int result = make_call((void *)(uintptr_t)peer, (void *)(uintptr_t)config, NULL, empty_string);
    printf("BOUNDARY: makeCall returned %d (not a connected call)\n", result);
    if (argc == 3 && (voice || pcm || !strcmp(argv[2], "--compat-audio"))) {
        void (*stop)(void *, unsigned char) = sym(h, "_ZN4zrtc4Peer4stopEb");
        puts("BOUNDARY: stopping native workers before destruction");
        stop((void *)(uintptr_t)peer, 1);
        puts("BOUNDARY: native stop returned");
    }
    free_peer(NULL, NULL, peer);
    free_config(NULL, NULL, config);
    if (pcm_failed) return 79;
    if (init_result != 0 || !result) {
        puts("NOT_READY: no connected call; initialization/signaling/media readiness not fully validated");
        return 78;
    }
    return 0;
}
