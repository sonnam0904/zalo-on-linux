/* glibc-side PCM bridge. Only raw s16le/48k/mono crosses process boundaries.
 * libpulse stays out of the Bionic address space. Pulse's stable public simple
 * API is dynamically loaded so runtime users do not need development headers.
 */
#include <dlfcn.h>
#include <errno.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

typedef struct pa_simple pa_simple;
typedef struct { int format; uint32_t rate; uint8_t channels; } sample_spec;
typedef struct { uint32_t maxlength, tlength, prebuf, minreq, fragsize; } buffer_attr;
static void *sym(void *h, const char *name) {
    void *p = dlsym(h, name);
    if (!p) { fprintf(stderr, "%s\n", dlerror()); exit(2); }
    return p;
}
static int transfer(int fd, void *buf, size_t size, int writing) {
    size_t done = 0;
    while (done < size) {
        ssize_t n = writing ? write(fd, (char *)buf + done, size - done)
                            : read(fd, (char *)buf + done, size - done);
        if (n < 0 && errno == EINTR) continue;
        if (n <= 0) return done ? -1 : (int)n;
        done += (size_t)n;
    }
    return 1;
}
int main(int argc, char **argv) {
    if (argc < 2 || argc > 3 || (strcmp(argv[1], "playback") && strcmp(argv[1], "record"))) {
        fputs("usage: pcm-host playback|record [device]\n", stderr); return 2;
    }
    int recording = !strcmp(argv[1], "record");
    void *lib = dlopen("libpulse-simple.so.0", RTLD_NOW | RTLD_LOCAL);
    if (!lib) { fprintf(stderr, "%s\n", dlerror()); return 2; }
    pa_simple *(*open_stream)(const char *, const char *, int, const char *, const char *,
        const sample_spec *, const void *, const buffer_attr *, int *) = sym(lib, "pa_simple_new");
    int (*read_pcm)(pa_simple *, void *, size_t, int *) = sym(lib, "pa_simple_read");
    int (*write_pcm)(pa_simple *, const void *, size_t, int *) = sym(lib, "pa_simple_write");
    int (*drain)(pa_simple *, int *) = sym(lib, "pa_simple_drain");
    void (*close_stream)(pa_simple *) = sym(lib, "pa_simple_free");
    sample_spec spec = {3 /* PA_SAMPLE_S16LE */, 48000, 1};
    buffer_attr attr = {UINT32_MAX, 3840, UINT32_MAX, 960, 960};
    int error = 0;
    pa_simple *stream = open_stream(NULL, "Zalo native PCM", recording ? 2 : 1,
        argc == 3 ? argv[2] : NULL, recording ? "Call microphone" : "Call speaker",
        &spec, NULL, &attr, &error);
    if (!stream) { fprintf(stderr, "PCM_OPEN_FAILED pulse_error=%d\n", error); return 3; }
    /* fd 3 is the parent's dedicated readiness pipe, not the PCM stream. */
    if (getenv("ZRTC_PCM_READY_FD") && write(3, "R", 1) != 1) {
        close_stream(stream); return 4;
    }
    if (getenv("ZRTC_PCM_READY_FD")) close(3);
    int result = 0;
    unsigned char pcm[960];
    while (1) {
        if (recording) {
            if (read_pcm(stream, pcm, sizeof pcm, &error) < 0) { result = 5; break; }
            if (transfer(STDOUT_FILENO, pcm, sizeof pcm, 1) <= 0) break;
        } else {
            int r = transfer(STDIN_FILENO, pcm, sizeof pcm, 0);
            if (r == 0) break;
            if (r < 0 || write_pcm(stream, pcm, sizeof pcm, &error) < 0) { result = 5; break; }
        }
    }
    if (!recording && !result && drain(stream, &error) < 0) result = 5;
    close_stream(stream);
    dlclose(lib);
    if (result) fprintf(stderr, "PCM_IO_FAILED pulse_error=%d\n", error);
    return result;
}
