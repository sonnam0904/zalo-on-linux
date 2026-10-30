/* Invoke the real APK C++ -> JNI callback wrappers with synthetic fixtures.
 * No sockets, accounts, or signaling requests are involved. */
#include "compat-jni.h"
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define STR "NSt6__ndk112basic_stringIcNS0_11char_traitsIcEENS0_9allocatorIcEEEE"
static void *symbol(void *lib, const char *name) {
    void *p = dlsym(lib, name);
    if (!p) { fprintf(stderr, "%s\n", dlerror()); exit(2); }
    return p;
}
static const struct { const char *name, *symbol; } cases[] = {
    {"onMakeCall", "_ZN15JniCallCallback10onMakeCallEv"},
    {"onIncomingCall", "_ZN15JniCallCallback14onIncomingCallEv"},
    {"onCallAutoHangup", "_ZN15JniCallCallback16onCallAutoHangupEv"},
    {"onCallState", "_ZN15JniCallCallback11onCallStateEi"},
    {"onCallAudioState", "_ZN15JniCallCallback16onCallAudioStateEi"},
    {"onCallVideoState", "_ZN15JniCallCallback16onCallVideoStateEi"},
    {"onCallQualityChanged", "_ZN15JniCallCallback20onCallQualityChangedEi"},
    {"onInitZrtpRequestFailed", "_ZN15JniCallCallback23onInitZrtpRequestFailedEi"},
    {"onCallErr", "_ZN15JniCallCallback9onCallErrEi"},
    {"onCallStats", "_ZN15JniCallCallback11onCallStatsERK" STR},
    {"onCallLog", "_ZN15JniCallCallback9onCallLogERK" STR},
    {"onCallRequest", "_ZN15JniCallCallback13onCallRequestEiiii" STR},
    {"onPreConnectSuccessful", "_ZN15JniCallCallback22onPreConnectSuccessfulEiii" STR},
    {"onInitZrtpWithServer", "_ZN15JniCallCallback20onInitZrtpWithServerE" STR "S6_"},
    {"onCallChangeZRTP", "_ZN15JniCallCallback16onCallChangeZRTPEi" STR "S6_S6_"},
    {"onCallUpdateP2PStatus", "_ZN15JniCallCallback21onCallUpdateP2PStatusEii"},
    {"onEnableLowDataModeComplete", "_ZN15JniCallCallback27onEnableLowDataModeCompleteEbb"},
};
typedef struct { const char *expected; unsigned calls; int failed; } Check;
static void sink(void *opaque, const char *name, const ZrtcEventValue *v, size_t n) {
    Check *c = opaque;
    c->calls++;
    if (strcmp(c->expected, name)) { c->failed = 1; return; }
    const char *types = zrtc_event_types(name);
    if (!types || n != strlen(types)) { c->failed = 1; return; }
    for (size_t i = 0; i < n; i++) {
        if (v[i].type != types[i]) c->failed = 1;
        if (types[i] == 'S') {
            if (!v[i].string || strcmp(v[i].string, "fixture\"\n\\")) c->failed = 1;
        } else if (v[i].integer != (types[i] == 'Z' ? (int)(i == 0) : 123 + (int)i)) c->failed = 1;
    }
}
int zrtc_probe_callbacks(void *lib) {
    Check check = {0};
    jobject object = zrtc_linux_call_callback(sink, &check, 37);
    /* Allocation size is 0xa8 in the pinned PeerJNI make_call wrapper. Use
       placement constructor / non-deleting destructor on this owned storage. */
    void *native = calloc(1, 0xa8);
    if (!native) return -1;
    void (*ctor)(void *, jobject) = symbol(lib, "_ZN15JniCallCallbackC1EP8_jobject");
    void (*dtor)(void *) = symbol(lib, "_ZN15JniCallCallbackD1Ev");
    int (*network)(void *) = symbol(lib, "_ZN15JniCallCallback14getNetworkTypeEv");
    ctor(native, object);
    if (network(native) != 37) check.failed = 1; /* fixture, not a real network enum */
    for (size_t i = 0; i < sizeof cases / sizeof cases[0]; i++) {
        check.expected = cases[i].name;
        const char *types = zrtc_event_types(check.expected);
        void *fn = symbol(lib, cases[i].symbol);
        /* x86_64 NDK short string: length*2, inline bytes, total 24 bytes.
           Nontrivial by-value and const-ref arguments are indirect here. */
        unsigned char a[24] = {0}, b[24] = {0}, c[24] = {0};
        const char *fixture = "fixture\"\n\\";
        a[0] = (unsigned char)(strlen(fixture) * 2);
        memcpy(a + 1, fixture, strlen(fixture)); memcpy(b, a, 24); memcpy(c, a, 24);
        if (!strcmp(types, "")) ((void (*)(void *))fn)(native);
        else if (!strcmp(types, "I")) ((void (*)(void *, int))fn)(native, 123);
        else if (!strcmp(types, "II")) ((void (*)(void *, int, int))fn)(native, 123, 124);
        else if (!strcmp(types, "ZZ")) ((void (*)(void *, unsigned char, unsigned char))fn)(native, 1, 0);
        else if (!strcmp(types, "S")) ((void (*)(void *, void *))fn)(native, a);
        else if (!strcmp(types, "SS")) ((void (*)(void *, void *, void *))fn)(native, a, b);
        else if (!strcmp(types, "ISSS")) ((void (*)(void *, int, void *, void *, void *))fn)(native, 123, a, b, c);
        else if (!strcmp(types, "IIIS")) ((void (*)(void *, int, int, int, void *))fn)(native, 123, 124, 125, a);
        else if (!strcmp(types, "IIIIS")) ((void (*)(void *, int, int, int, int, void *))fn)(native, 123, 124, 125, 126, a);
        else check.failed = 1;
    }
    /* More string callbacks than the metadata arena capacity: verify that
       native DeleteLocalRef paths actually reclaim transient payloads. */
    check.expected = "onCallStats";
    void (*stats)(void *, const void *) = symbol(lib, cases[9].symbol);
    unsigned char fixture[24] = {20, 'f','i','x','t','u','r','e','"','\n','\\'};
    for (int i = 0; i < 10000; i++) stats(native, fixture);
    dtor(native); free(native);
    JNIEnv *env = zrtc_linux_env();
    (*env)->DeleteLocalRef(env, object);
    if (check.failed || check.calls != 10000 + sizeof cases / sizeof cases[0]) {
        fprintf(stderr, "FAIL native callback values/count: %u\n", check.calls); return -1;
    }
    puts("PASS 17 real native callback wrappers + network query; 10000 transient string callbacks reclaimed");
    return 0;
}
