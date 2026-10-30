/* Probe adapters only. No audio/device implementation is claimed. */
#include <stdio.h>
#include <stdarg.h>
#include <stdlib.h>
#include <SLES/OpenSLES.h>
#include <SLES/OpenSLES_Android.h>

int __android_log_vprint(int priority, const char *tag, const char *fmt, va_list ap) {
    (void)priority;
    fprintf(stderr, "[%s] ", tag ? tag : "android");
    int n = vfprintf(stderr, fmt, ap);
    fputc('\n', stderr);
    return n;
}
int __android_log_print(int priority, const char *tag, const char *fmt, ...) {
    va_list ap;
    va_start(ap, fmt);
    int n = __android_log_vprint(priority, tag, fmt, ap);
    va_end(ap);
    return n;
}
int __android_log_write(int priority, const char *tag, const char *text) {
    return __android_log_print(priority, tag, "%s", text ? text : "");
}

/* Placeholder IDs: dereferencing one is not supported by this probe. */
#define IID(name) static const struct SLInterfaceID_ id_##name = {0}; \
    const SLInterfaceID name = &id_##name
IID(SL_IID_ANDROIDCONFIGURATION);
IID(SL_IID_ANDROIDSIMPLEBUFFERQUEUE);
IID(SL_IID_BUFFERQUEUE);
IID(SL_IID_ENGINE);
IID(SL_IID_PLAY);
IID(SL_IID_RECORD);
IID(SL_IID_VOLUME);

SLresult slCreateEngine(SLObjectItf *engine, SLuint32 count,
                       const SLEngineOption *options, SLuint32 n,
                       const SLInterfaceID *ids, const SLboolean *required) {
    (void)count; (void)options; (void)n; (void)ids; (void)required;
    if (engine) *engine = NULL;
    fputs("UNIMPLEMENTED: OpenSLES audio backend; returning FEATURE_UNSUPPORTED\n", stderr);
    return SL_RESULT_FEATURE_UNSUPPORTED;
}
