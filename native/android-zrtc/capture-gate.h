#pragma once
#include <pthread.h>
#include <stddef.h>
#include <string.h>
typedef struct { int muted; unsigned long input_nonzero, output_nonzero, muted_frames; } ZrtcCaptureStats;
typedef struct { pthread_mutex_t lock; int muted; unsigned long input_nonzero, output_nonzero, muted_frames; } ZrtcCaptureGate;
#define ZRTC_CAPTURE_GATE_INIT {PTHREAD_MUTEX_INITIALIZER, 0, 0, 0, 0}
static inline ZrtcCaptureStats zrtc_capture_gate_stats(ZrtcCaptureGate *gate) {
    pthread_mutex_lock(&gate->lock);
    ZrtcCaptureStats stats = {gate->muted, gate->input_nonzero, gate->output_nonzero, gate->muted_frames};
    pthread_mutex_unlock(&gate->lock);
    return stats;
}
static inline void zrtc_capture_gate_set(ZrtcCaptureGate *gate, int muted) {
    pthread_mutex_lock(&gate->lock);
    gate->muted = muted != 0;
    pthread_mutex_unlock(&gate->lock);
}
/* Hold through the recording callback. A setter cannot acknowledge while
 * an earlier unmuted PCM block is still being handed to the encoder. This
 * cannot recall audio already encoded or sent before the setter acquired it. */
static inline void zrtc_capture_gate_begin(ZrtcCaptureGate *gate, void *pcm, size_t bytes) {
    pthread_mutex_lock(&gate->lock);
    int nonzero = 0;
    const unsigned char *samples = pcm;
    for (size_t i = 0; i < bytes; i++) if (samples[i]) { nonzero = 1; break; }
    gate->input_nonzero += nonzero;
    if (gate->muted) { memset(pcm, 0, bytes); gate->muted_frames++; }
    else gate->output_nonzero += nonzero;
}
static inline void zrtc_capture_gate_end(ZrtcCaptureGate *gate) {
    pthread_mutex_unlock(&gate->lock);
}
