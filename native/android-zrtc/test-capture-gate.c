#include "capture-gate.h"
#include <assert.h>
#include <stdatomic.h>
#include <sched.h>
#include <stdio.h>
static ZrtcCaptureGate gate = ZRTC_CAPTURE_GATE_INIT;
static atomic_int entered, acknowledged;
static void *mute(void *unused) {
    (void)unused;
    atomic_store(&entered, 1);
    zrtc_capture_gate_set(&gate, 1);
    atomic_store(&acknowledged, 1);
    return NULL;
}
int main(void) {
    unsigned char pcm[640];
    memset(pcm, 37, sizeof pcm);
    zrtc_capture_gate_begin(&gate, pcm, sizeof pcm);
    pthread_t thread;
    assert(!pthread_create(&thread, NULL, mute, NULL));
    while (!atomic_load(&entered)) sched_yield();
    assert(!atomic_load(&acknowledged));
    for (size_t i=0;i<sizeof pcm;i++) assert(pcm[i]==37);
    zrtc_capture_gate_end(&gate);
    assert(!pthread_join(thread, NULL));
    assert(atomic_load(&acknowledged));
    for (int cycle=0;cycle<1000;cycle++) {
        for (int muted=1;muted>=0;muted--) {
            zrtc_capture_gate_set(&gate, muted);
            memset(pcm, 37, sizeof pcm);
            zrtc_capture_gate_begin(&gate, pcm, sizeof pcm);
            for (size_t i=0;i<sizeof pcm;i++) assert(pcm[i]==(muted?0:37));
            zrtc_capture_gate_end(&gate);
        }
    }
    ZrtcCaptureStats stats = zrtc_capture_gate_stats(&gate);
    assert(stats.muted == 0 && stats.input_nonzero == 2001 && stats.output_nonzero == 1001 && stats.muted_frames == 1000);
    puts("PASS capture gate: silent muted PCM, restored samples, synchronized acknowledgment, aggregate counters, 1000 cycles");
}
