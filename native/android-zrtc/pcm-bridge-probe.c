/* Real Bionic -> glibc -> Pulse round trip. Use only an isolated null sink. */
#include "pcm-bridge.h"
#include <math.h>
#include <pthread.h>
#include <signal.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static ZrtcPcm playback = {-1, 0}, capture = {-1, 0};
static int stopping, playback_failed;
static void *play(void *unused) {
    (void)unused;
    int16_t frame[480];
    unsigned long sample = 0;
    while (!__atomic_load_n(&stopping, __ATOMIC_ACQUIRE)) {
        for (int i = 0; i < 480; i++, sample++)
            frame[i] = (int16_t)lrint(12000 * sin(2 * 3.141592653589793 * 440 * sample / 48000));
        if (zrtc_pcm_transfer(&playback, frame, sizeof frame, 0, &stopping)) {
            if (!__atomic_load_n(&stopping, __ATOMIC_ACQUIRE)) playback_failed = 1;
            break;
        }
    }
    return NULL;
}
int main(void) {
    const char *sink = getenv("ZRTC_PCM_SINK"), *source = getenv("ZRTC_PCM_SOURCE");
    if (!sink || strncmp(sink, "zrtc_native_test_", 17) || !source ||
        strncmp(source, sink, strlen(sink)) || strcmp(source + strlen(sink), ".monitor")) {
        fputs("Probe requires an isolated zrtc_native_test_* sink and its monitor\n", stderr);
        return 2;
    }
    signal(SIGPIPE, SIG_IGN);
    if (zrtc_pcm_open(&capture, 1)) return 3;
    if (zrtc_pcm_open(&playback, 0)) { zrtc_pcm_close(&capture); return 3; }
    pthread_t thread;
    if (pthread_create(&thread, NULL, play, NULL)) {
        zrtc_pcm_close(&capture); zrtc_pcm_close(&playback); return 4;
    }
    double peak = 0;
    int failed = 0;
    for (int block = 0; block < 25; block++) {
        int16_t pcm[4800];
        if (zrtc_pcm_transfer(&capture, pcm, sizeof pcm, 1, &stopping)) { failed = 1; break; }
        double real = 0, imag = 0;
        for (int i = 0; i < 4800; i++) {
            double phase = 2 * 3.141592653589793 * 440 * i / 48000;
            real += pcm[i] * cos(phase); imag += pcm[i] * sin(phase);
        }
        double amplitude = 2 * hypot(real, imag) / 4800;
        if (amplitude > peak) peak = amplitude;
    }
    __atomic_store_n(&stopping, 1, __ATOMIC_RELEASE);
    pthread_join(thread, NULL);
    zrtc_pcm_close(&capture); zrtc_pcm_close(&playback);
    if (failed || playback_failed || peak < 5000) {
        fprintf(stderr, "FAIL Bionic PCM roundtrip amplitude=%.0f\n", peak); return 5;
    }
    printf("PASS Bionic -> glibc -> Pulse PCM: 440Hz amplitude=%.0f; both helpers reaped\n", peak);
    return 0;
}
