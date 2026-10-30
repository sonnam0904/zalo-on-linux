#pragma once
#include <jni.h>
#include "call-events.h"
#include "capture-gate.h"
JNIEnv *zrtc_linux_env(void);
JavaVM *zrtc_linux_vm(void);
jobject zrtc_linux_context(void);
/* Offline diagnostics only: native audio objects owned by the engine. */
void *zrtc_linux_audio_object(int recording);
unsigned long zrtc_linux_audio_frames(int recording);
unsigned long zrtc_linux_audio_failures(void);
void zrtc_linux_audio_set_muted(int muted);
ZrtcCaptureStats zrtc_linux_audio_capture_stats(void);
jobject zrtc_linux_call_callback(ZrtcEventSink sink, void *opaque, int network_type);
unsigned zrtc_linux_refs(jobject object);
