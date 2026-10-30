/* Incremental native implementation of the engine's JNI boundary.
 * This is not a Java VM. Unknown Java operations stop with an explicit error.
 * Handles are private native metadata, never pointers into an actual JVM.
 */
#include "compat-jni.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <stdarg.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include "pcm-bridge.h"
#include "capture-gate.h"
static ZrtcCaptureGate capture_gate = ZRTC_CAPTURE_GATE_INIT;
void zrtc_linux_audio_set_muted(int muted) { zrtc_capture_gate_set(&capture_gate, muted); }
ZrtcCaptureStats zrtc_linux_audio_capture_stats(void) { return zrtc_capture_gate_stats(&capture_gate); }

typedef struct Handle {
    char *kind;
    char *name;
    char *signature;
    jlong native;
    void *buffer;
    jlong capacity;
    ZrtcPcm pcm;
    pthread_t thread;
    int initialized, running, stopping, recording;
    unsigned long frames;
    ZrtcEventSink sink;
    void *opaque;
    int network_type;
    unsigned references;
} Handle;
static struct JNINativeInterface table;
static const struct JNIInvokeInterface invoke;
static JNIEnv env = &table;
static JavaVM vm = &invoke;
static _Thread_local int attached;
static Handle handles[1024];
static size_t count;
static pthread_mutex_t handles_lock = PTHREAD_MUTEX_INITIALIZER;
typedef struct { char *klass; JNINativeMethod method; } Native;
static Native natives[256];
static size_t native_count;
static unsigned long audio_failures;
unsigned long zrtc_linux_audio_failures(void) {
    return __atomic_load_n(&audio_failures, __ATOMIC_ACQUIRE);
}
static void audio_failed(void) { __atomic_add_fetch(&audio_failures, 1, __ATOMIC_RELEASE); }

static _Noreturn void unsupported(void) {
    fputs("JNI_UNIMPLEMENTED: unhandled JNI table operation\n", stderr);
    exit(78);
}
static Handle *handle(const char *kind, const char *name, const char *sig) {
    /* Stable slots with reclamation: callback strings must not exhaust the
       arena during a long call. Full implicit JNI local frames remain TODO. */
    pthread_mutex_lock(&handles_lock);
    int klass = !strcmp(kind, "class"), method_id = !strcmp(kind, "method");
    if (klass || method_id) {
        for (size_t i = 0; i < count; i++) {
            Handle *old = &handles[i];
            if (old->references && !strcmp(old->kind, kind) && !strcmp(old->name, name) &&
                !strcmp(old->signature, sig ? sig : "")) {
                if (klass) ++old->references; /* cache root plus returned local ref */
                pthread_mutex_unlock(&handles_lock);
                return old;
            }
        }
    }
    size_t slot = 0;
    while (slot < count && handles[slot].references) ++slot;
    if (slot == sizeof handles / sizeof handles[0]) unsupported();
    if (slot == count) ++count;
    Handle *h = &handles[slot];
    memset(h, 0, sizeof *h);
    h->kind = strdup(kind);
    h->name = strdup(name);
    h->signature = strdup(sig ? sig : "");
    h->pcm.fd = -1;
    h->references = klass ? 2 : 1;
    if (!h->kind || !h->name || !h->signature) abort();
    pthread_mutex_unlock(&handles_lock);
    return h;
}
static jint get_version(JNIEnv *e) { (void)e; return JNI_VERSION_1_6; }
static jclass find_class(JNIEnv *e, const char *name) {
    (void)e;
    fprintf(stderr, "JNI class %s\n", name);
    return (jclass)handle("class", name, "");
}
static jobject new_ref(JNIEnv *e, jobject o) {
    (void)e;
    if (!o) return NULL;
    pthread_mutex_lock(&handles_lock);
    Handle *h = (Handle *)o;
    if (!h->references) unsupported();
    ++h->references;
    pthread_mutex_unlock(&handles_lock);
    return o;
}
static void delete_ref(JNIEnv *e, jobject o) {
    (void)e;
    if (!o) return;
    pthread_mutex_lock(&handles_lock);
    Handle *h = (Handle *)o;
    if (!h->references) unsupported();
    if (!--h->references) {
        /* A device's native owner must stop it before releasing its last ref. */
        if (h->running || h->pcm.fd >= 0) unsupported();
        free(h->kind); free(h->name); free(h->signature); free(h->buffer);
        memset(h, 0, sizeof *h); h->pcm.fd = -1;
    }
    pthread_mutex_unlock(&handles_lock);
}
static jboolean same(JNIEnv *e, jobject a, jobject b) { (void)e; return a == b; }
static jthrowable exception(JNIEnv *e) { (void)e; return NULL; }
static jboolean exception_check(JNIEnv *e) { (void)e; return JNI_FALSE; }
static void exception_clear(JNIEnv *e) { (void)e; }
static jint get_vm(JNIEnv *e, JavaVM **v) { (void)e; *v = &vm; return JNI_OK; }
static jclass object_class(JNIEnv *e, jobject o) {
    if (!o) unsupported();
    Handle *h = (Handle *)o;
    return find_class(e, h->kind);
}
static jmethodID method(JNIEnv *e, jclass c, const char *name, const char *sig) {
    (void)e;
    Handle *h = (Handle *)c;
    if (!h) unsupported();
    char full[512];
    if (snprintf(full, sizeof full, "%s.%s", h->name, name) >= (int)sizeof full) unsupported();
    fprintf(stderr, "JNI method %s %s\n", full, sig);
    return (jmethodID)handle("method", full, sig);
}
static jfieldID field(JNIEnv *e, jclass c, const char *name, const char *sig) {
    return (jfieldID)method(e, c, name, sig);
}
static jint static_int(JNIEnv *e, jclass c, jfieldID f) {
    (void)e; (void)c;
    Handle *h = (Handle *)f;
    if (!strcmp(h->name, "android/os/Build$VERSION.SDK_INT")) return 21;
    fprintf(stderr, "JNI_UNIMPLEMENTED field %s\n", h->name); exit(78);
}
static jstring new_string(JNIEnv *e, const char *s) {
    (void)e; return (jstring)handle("java/lang/String", s, "");
}
static const char *string_chars(JNIEnv *e, jstring s, jboolean *copy) {
    (void)e;
    if (!s || strcmp(((Handle *)s)->kind, "java/lang/String")) unsupported();
    if (copy) *copy = JNI_FALSE;
    return ((Handle *)s)->name;
}
static void release_string(JNIEnv *e, jstring s, const char *p) { (void)e; (void)s; (void)p; }
static jobject call_object_v(JNIEnv *e, jobject o, jmethodID m, va_list args) {
    (void)o; (void)args;
    Handle *h = (Handle *)m;
    if (!strcmp(h->name, "org/webrtc/MediaCodecVideoEncoder.getChipsetFamily"))
        return new_string(e, "unknown"); /* No Android MediaCodec chipset on Linux. */
    fprintf(stderr, "JNI_UNIMPLEMENTED object method %s %s\n", h->name, h->signature);
    exit(78);
}
static jobject call_static_object_v(JNIEnv *e, jclass c, jmethodID m, va_list args) {
    return call_object_v(e, (jobject)c, m, args);
}
static jint register_natives(JNIEnv *e, jclass c, const JNINativeMethod *methods, jint n) {
    (void)e;
    if (!c || n < 0 || native_count + (size_t)n > 256) return JNI_ERR;
    for (jint i = 0; i < n; ++i) {
        Native *entry = &natives[native_count++];
        entry->klass = strdup(((Handle *)c)->name);
        entry->method.name = strdup(methods[i].name);
        entry->method.signature = strdup(methods[i].signature);
        entry->method.fnPtr = methods[i].fnPtr;
        fprintf(stderr, "JNI native %s.%s %s\n", entry->klass, methods[i].name, methods[i].signature);
    }
    return JNI_OK;
}
static void cache_buffer(JNIEnv *e, Handle *object) {
    for (size_t i = 0; i < native_count; ++i) {
        Native *entry = &natives[i];
        if (strcmp(entry->klass, object->kind) ||
            strcmp(entry->method.name, "nativeCacheDirectBufferAddress")) continue;
        if (strcmp(entry->method.signature, "(Ljava/nio/ByteBuffer;J)V")) unsupported();
        void (*cache)(JNIEnv *, jobject, jobject, jlong) = entry->method.fnPtr;
        cache(e, (jobject)object, (jobject)object, object->native);
        return;
    }
    unsupported();
}
static jobject new_object_v(JNIEnv *e, jclass c, jmethodID m, va_list args) {
    Handle *method_handle = (Handle *)m;
    if ((!strcmp(method_handle->name, "org/webrtc/voiceengine/WebRtcAudioTrack.<init>") ||
         !strcmp(method_handle->name, "org/webrtc/voiceengine/WebRtcAudioRecord.<init>")) &&
        !strcmp(method_handle->signature, "(Landroid/content/Context;J)V")) {
        (void)va_arg(args, jobject);
        jlong native = va_arg(args, jlong);
        Handle *object = handle(((Handle *)c)->name, "linux-pcm-device", "");
        object->native = native;
        object->capacity = 480 * 2; /* 10 ms mono s16le at 48 kHz. */
        object->buffer = calloc(1, (size_t)object->capacity);
        if (!object->buffer) abort();
        cache_buffer(e, object);
        return (jobject)object;
    }
    if (!strcmp(method_handle->name, "org/webrtc/voiceengine/WebRtcAudioManager.<init>") &&
        !strcmp(method_handle->signature, "(Landroid/content/Context;J)V")) {
        (void)va_arg(args, jobject);
        jlong native = va_arg(args, jlong);
        Handle *object = handle(((Handle *)c)->name, "linux-audio-manager", "");
        object->native = native;
        for (size_t i = 0; i < native_count; ++i) {
            Native *entry = &natives[i];
            if (strcmp(entry->klass, object->kind) ||
                strcmp(entry->method.name, "nativeCacheAudioParameters")) continue;
            if (strcmp(entry->method.signature, "(IIZZZZZIIJ)V")) unsupported();
            void (*cache)(JNIEnv *, jobject, jint, jint, jboolean, jboolean,
                          jboolean, jboolean, jboolean, jint, jint, jlong) = entry->method.fnPtr;
            /* PCM transport contract, not a claim about physical devices:
               48 kHz mono, 10 ms frames; no Android hardware effects/OpenSLES. */
            cache(e, (jobject)object, 48000, 1, 0, 0, 0, 0, 0, 480, 480, native);
            return (jobject)object;
        }
        unsupported();
    }
    return call_object_v(e, (jobject)c, m, args);
}
static void *direct_buffer(JNIEnv *e, jobject o) {
    (void)e; if (!o) return NULL; return ((Handle *)o)->buffer;
}
static jlong direct_capacity(JNIEnv *e, jobject o) {
    (void)e; if (!o || !((Handle *)o)->buffer) return -1; return ((Handle *)o)->capacity;
}
static void *audio_thread(void *arg) {
    Handle *h = arg;
    attached = 1;
    sigset_t mask;
    sigemptyset(&mask); sigaddset(&mask, SIGPIPE);
    pthread_sigmask(SIG_BLOCK, &mask, NULL);
    void (*callback)(JNIEnv *, jobject, jint, jlong) = NULL;
    const char *name = h->recording ? "nativeDataIsRecorded" : "nativeGetPlayoutData";
    for (size_t i = 0; i < native_count; i++)
        if (!strcmp(natives[i].klass, h->kind) && !strcmp(natives[i].method.name, name) &&
            !strcmp(natives[i].method.signature, "(IJ)V")) callback = natives[i].method.fnPtr;
    if (!callback) unsupported();
    while (!__atomic_load_n(&h->stopping, __ATOMIC_ACQUIRE)) {
        if (!h->recording) callback(&env, (jobject)h, (jint)h->capacity, h->native);
        if (zrtc_pcm_transfer(&h->pcm, h->buffer, (size_t)h->capacity, h->recording, &h->stopping)) {
            if (!__atomic_load_n(&h->stopping, __ATOMIC_ACQUIRE)) audio_failed();
            break;
        }
        if (h->recording) {
            zrtc_capture_gate_begin(&capture_gate, h->buffer, (size_t)h->capacity);
            callback(&env, (jobject)h, (jint)h->capacity, h->native);
            zrtc_capture_gate_end(&capture_gate);
        }
        __atomic_add_fetch(&h->frames, 1, __ATOMIC_RELEASE);
    }
    attached = 0;
    return NULL;
}
static void stop_audio(Handle *h) {
    __atomic_store_n(&h->stopping, 1, __ATOMIC_RELEASE);
    if (h->running) { pthread_join(h->thread, NULL); h->running = 0; }
    zrtc_pcm_close(&h->pcm);
    h->initialized = 0;
}
static int start_audio(Handle *h) {
    if (!h->initialized || h->pcm.fd < 0 || h->running) return 0;
    __atomic_store_n(&h->stopping, 0, __ATOMIC_RELEASE);
    if (pthread_create(&h->thread, NULL, audio_thread, h)) { audio_failed(); return 0; }
    h->running = 1;
    return 1;
}
static jboolean call_boolean_v(JNIEnv *e, jobject o, jmethodID m, va_list args) {
    (void)e; (void)args;
    Handle *h = (Handle *)m;
    Handle *object = (Handle *)o;
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioManager.init")) {
        object->initialized = 1; return JNI_TRUE; /* Manager metadata; streams open separately. */
    }
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioManager.isCommunicationModeEnabled"))
        return JNI_FALSE; /* Linux does not set an Android communication mode. */
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioTrack.startPlayout") ||
        !strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioRecord.startRecording"))
        return start_audio(object);
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioTrack.stopPlayout") ||
        !strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioRecord.stopRecording")) {
        stop_audio(object); return JNI_TRUE;
    }
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioRecord.enableBuiltInAEC") ||
        !strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioRecord.enableBuiltInAGC") ||
        !strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioRecord.enableBuiltInNS"))
        return va_arg(args, int) ? JNI_FALSE : JNI_TRUE;
    /* OpenSLES has no backend. Let WebRTC select the JNI PCM path. */
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioManager.isDeviceBlacklistedForOpenSLESUsage"))
        return JNI_TRUE;
    fprintf(stderr, "JNI_UNIMPLEMENTED boolean method %s %s\n", h->name, h->signature);
    exit(78);
}
static jint call_int_v(JNIEnv *e, jobject o, jmethodID m, va_list args) {
    (void)e;
    Handle *h = (Handle *)m, *object = (Handle *)o;
    if (object && !strcmp(object->kind, "com/vng/zing/vn/zrtc/CallCallback") &&
        !strcmp(h->name, "com/vng/zing/vn/zrtc/CallCallback.getNetworkType") &&
        !strcmp(h->signature, "()I")) return object->network_type;
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioRecord.initRecording")) {
        /* Pinned AudioRecordJni::InitRecording disassembly passes rate,
           channels, then the Android source selector, not source first. */
        int rate = va_arg(args, int), channels = va_arg(args, int), source = va_arg(args, int);
        fprintf(stderr, "PCM initRecording source=%d rate=%d channels=%d\n", source, rate, channels);
        if (rate != 48000 || channels != 1) return -1;
        stop_audio(object);
        /* The native StopRecording/StopPlayout methods clear their cached
           direct-buffer pointer. Re-register on every stream initialization. */
        cache_buffer(e, object);
        object->recording = 1;
        if (zrtc_pcm_open(&object->pcm, 1)) { audio_failed(); return -1; }
        object->initialized = 1;
        return 480;
    }
    fprintf(stderr, "JNI_UNIMPLEMENTED int method %s %s\n", h->name, h->signature);
    exit(78);
}
static void call_void_v(JNIEnv *e, jobject o, jmethodID m, va_list args) {
    (void)e;
    Handle *h = (Handle *)m, *object = (Handle *)o;
    const char *prefix = "com/vng/zing/vn/zrtc/CallCallback.";
    if (object && !strcmp(object->kind, "com/vng/zing/vn/zrtc/CallCallback") &&
        !strncmp(h->name, prefix, strlen(prefix))) {
        const char *name = h->name + strlen(prefix);
        const char *signature = zrtc_event_signature(name), *types = zrtc_event_types(name);
        if (!signature || strcmp(signature, h->signature) || !object->sink) unsupported();
        ZrtcEventValue values[5] = {0};
        size_t n = strlen(types);
        if (n > 5) unsupported();
        for (size_t i = 0; i < n; i++) {
            values[i].type = types[i];
            if (types[i] == 'S') {
                Handle *string = (Handle *)va_arg(args, jstring);
                if (string && strcmp(string->kind, "java/lang/String")) unsupported();
                values[i].string = string ? string->name : NULL;
            } else {
                values[i].integer = va_arg(args, int);
                if (types[i] == 'Z') values[i].integer = !!values[i].integer;
            }
        }
        object->sink(object->opaque, name, values, n);
        return;
    }
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioManager.dispose")) {
        object->initialized = 0; return;
    }
    if (!strcmp(h->name, "org/webrtc/voiceengine/WebRtcAudioTrack.initPlayout")) {
        int rate = va_arg(args, int), channels = va_arg(args, int);
        fprintf(stderr, "PCM initPlayout rate=%d channels=%d\n", rate, channels);
        if (rate != 48000 || channels != 1) unsupported();
        stop_audio(object);
        cache_buffer(e, object);
        object->recording = 0;
        if (zrtc_pcm_open(&object->pcm, 0)) { audio_failed(); return; }
        object->initialized = 1; return;
    }
    fprintf(stderr, "JNI_UNIMPLEMENTED void method %s %s\n", h->name, h->signature);
    exit(78);
}
static jint attach(JavaVM *v, JNIEnv **e, void *args) {
    (void)v; (void)args; attached = 1; *e = &env; return JNI_OK;
}
static jint detach(JavaVM *v) { (void)v; attached = 0; return JNI_OK; }
static jint get_env(JavaVM *v, void **e, jint version) {
    (void)v;
    *e = NULL;
    if (version != JNI_VERSION_1_6 && version != JNI_VERSION_1_4) return JNI_EVERSION;
    if (!attached) return JNI_EDETACHED;
    *e = &env; return JNI_OK;
}
static const struct JNIInvokeInterface invoke = {
    .AttachCurrentThread = attach, .DetachCurrentThread = detach,
    .GetEnv = get_env, .AttachCurrentThreadAsDaemon = attach,
};

static void initialize_table(void) {
    /* Fail closed for every JNI operation not explicitly ported here. Function
       pointer representation is fixed by the pinned x86_64 ELF ABI. */
    void (*fail)(void) = unsupported;
    for (size_t i = 0; i < sizeof table; i += sizeof fail)
        memcpy((char *)&table + i, &fail, sizeof fail);
    table.GetVersion = get_version;
    table.FindClass = find_class;
    table.NewGlobalRef = new_ref; table.NewLocalRef = new_ref;
    table.DeleteGlobalRef = delete_ref; table.DeleteLocalRef = delete_ref;
    table.IsSameObject = same; table.GetObjectClass = object_class;
    table.ExceptionOccurred = exception; table.ExceptionCheck = exception_check;
    table.ExceptionClear = exception_clear;
    table.GetJavaVM = get_vm;
    table.GetMethodID = method; table.GetStaticMethodID = method;
    table.GetStaticFieldID = field; table.GetStaticIntField = static_int;
    table.NewStringUTF = new_string; table.GetStringUTFChars = string_chars;
    table.ReleaseStringUTFChars = release_string;
    table.CallObjectMethodV = call_object_v;
    table.CallStaticObjectMethodV = call_static_object_v;
    table.RegisterNatives = register_natives;
    table.NewObjectV = new_object_v;
    table.GetDirectBufferAddress = direct_buffer;
    table.GetDirectBufferCapacity = direct_capacity;
    table.CallBooleanMethodV = call_boolean_v;
    table.CallIntMethodV = call_int_v;
    table.CallVoidMethodV = call_void_v;
}
JNIEnv *zrtc_linux_env(void) {
    static pthread_once_t once = PTHREAD_ONCE_INIT;
    pthread_once(&once, initialize_table);
    attached = 1;
    return &env;
}
jobject zrtc_linux_context(void) {
    return (jobject)handle("android/content/Context", "linux-native-context", "");
}
JavaVM *zrtc_linux_vm(void) { return &vm; }
unsigned zrtc_linux_refs(jobject o) {
    pthread_mutex_lock(&handles_lock);
    unsigned n = o ? ((Handle *)o)->references : 0;
    pthread_mutex_unlock(&handles_lock);
    return n;
}
jobject zrtc_linux_call_callback(ZrtcEventSink sink, void *opaque, int network_type) {
    if (!sink) return NULL;
    Handle *h = handle("com/vng/zing/vn/zrtc/CallCallback", "linux-call-callback", "");
    h->sink = sink; h->opaque = opaque; h->network_type = network_type;
    return (jobject)h;
}
static Handle *audio_object(int recording) {
    const char *kind = recording ? "org/webrtc/voiceengine/WebRtcAudioRecord" :
                                  "org/webrtc/voiceengine/WebRtcAudioTrack";
    for (size_t i = count; i > 0; i--)
        if (handles[i-1].native && !strcmp(handles[i-1].kind, kind)) return &handles[i-1];
    return NULL;
}
void *zrtc_linux_audio_object(int recording) {
    Handle *h = audio_object(recording);
    return h ? (void *)(uintptr_t)h->native : NULL;
}
unsigned long zrtc_linux_audio_frames(int recording) {
    Handle *h = audio_object(recording);
    return h ? __atomic_load_n(&h->frames, __ATOMIC_ACQUIRE) : 0;
}
