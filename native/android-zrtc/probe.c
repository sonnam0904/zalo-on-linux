#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <stdint.h>
#include <math.h>
#include <string.h>
#include <sys/utsname.h>

static void *symbol(void *handle, const char *name) {
    void *p = dlsym(handle, name);
    if (!p) { fprintf(stderr, "dlsym: %s\n", dlerror()); exit(2); }
    return p;
}

static void opus_roundtrip(void *h) {
    /* Public libopus C ABI; use the APK's already-loaded dependency. */
    void *(*enc_new)(int32_t, int, int, int *) = symbol(h, "opus_encoder_create");
    void *(*dec_new)(int32_t, int, int *) = symbol(h, "opus_decoder_create");
    int (*encode)(void *, const int16_t *, int, unsigned char *, int32_t) = symbol(h, "opus_encode");
    int (*decode)(void *, const unsigned char *, int32_t, int16_t *, int, int) = symbol(h, "opus_decode");
    void (*enc_free)(void *) = symbol(h, "opus_encoder_destroy");
    void (*dec_free)(void *) = symbol(h, "opus_decoder_destroy");
    int err = 0;
    void *enc = enc_new(48000, 1, 2048 /* OPUS_APPLICATION_VOIP */, &err);
    if (!enc || err) exit(6);
    void *dec = dec_new(48000, 1, &err);
    if (!dec || err) exit(6);
    int16_t input[960], output[960];
    unsigned char packet[4000];
    long long energy = 0;
    int total = 0;
    for (int frame = 0; frame < 50; ++frame) {
        for (int i = 0; i < 960; ++i)
            input[i] = (int16_t)(12000 * sin(2 * 3.141592653589793 * 440 * (frame * 960 + i) / 48000));
        int n = encode(enc, input, 960, packet, sizeof packet);
        if (n <= 0 || n > (int)sizeof packet) exit(6);
        int samples = decode(dec, packet, n, output, 960, 0);
        if (samples != 960) exit(6);
        for (int i = 0; i < samples; ++i) energy += (long long)output[i] * output[i];
        total += n;
    }
    if (energy < 48000LL * 100 * 100) exit(6);
    printf("PASS APK Opus: 50 frames, 48000 decoded samples, %d encoded bytes, non-silent PCM\n", total);
    enc_free(enc);
    dec_free(dec);
}

int main(int argc, char **argv) {
    setbuf(stdout, NULL);
    struct utsname host;
    uname(&host);
    printf("HOST %s %s %s\n", host.sysname, host.release, host.machine);
    if (argc != 2) { fprintf(stderr, "usage: probe /path/libzrtc.so\n"); return 2; }
    void *h = dlopen(argv[1], RTLD_NOW | RTLD_LOCAL);
    if (!h) { fprintf(stderr, "dlopen: %s\n", dlerror()); return 1; }
    puts("PASS dlopen RTLD_NOW: libzrtc constructors and relocations completed");
    opus_roundtrip(h);
    int (*init)(void) = symbol(h, "srtp_init");
    int (*shutdown_srtp)(void) = symbol(h, "srtp_shutdown");
    int status = init();
    printf("SRTP init=%d\n", status);
    if (status) return 3;
    status = shutdown_srtp();
    printf("SRTP shutdown=%d\n", status);
    if (status) return 3;
    int64_t (*create)(void *, void *) = symbol(h, "_Z31PeerJNI_zrtc_call_config_createP7_JNIEnvP7_jclass");
    void (*destroy)(void *, void *, int64_t) = symbol(h, "_Z31PeerJNI_zrtc_call_config_deleteP7_JNIEnvP7_jclassl");
    int64_t config = create(NULL, NULL);
    if (!config) return 4;
    puts("PASS native CallConfig constructor");
    destroy(NULL, NULL, config);
    puts("PASS native CallConfig destructor");
    int64_t (*peer_create)(void *, void *) = symbol(h, "_Z24PeerJNI_zrtc_peer_createP7_JNIEnvP7_jclass");
    void (*peer_destroy)(void *, void *, int64_t) = symbol(h, "_Z24PeerJNI_zrtc_peer_deleteP7_JNIEnvP7_jclassl");
    puts("TRY native Peer constructor");
    int64_t peer = peer_create(NULL, NULL);
    if (!peer) return 5;
    puts("PASS native Peer constructor");
    unsigned char (*in_call)(void *, void *, int64_t) = symbol(h, "_Z28PeerJNI_zrtc_peer_is_in_callP7_JNIEnvP7_jclassl");
    unsigned char (*in_video)(void *, void *, int64_t) = symbol(h, "_Z34PeerJNI_zrtc_peer_is_in_video_callP7_JNIEnvP7_jclassl");
    if (in_call(NULL, NULL, peer) || in_video(NULL, NULL, peer)) return 5;
    puts("PASS native Peer idle state (voice=false, video=false)");
    peer_destroy(NULL, NULL, peer);
    puts("PASS native Peer destructor");
    dlclose(h);
    puts("PASS native probe (no signaling or media devices exercised)");
    return 0;
}
