#define _GNU_SOURCE
#include "pcm-bridge.h"
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <sys/prctl.h>
#include <unistd.h>
extern char **environ;

void zrtc_pcm_close(ZrtcPcm *p) {
    if (p->fd >= 0) { close(p->fd); p->fd = -1; }
    if (p->pid > 0) {
        /* This PID belongs solely to this bridge, and has not been reaped. */
        kill(p->pid, SIGTERM);
        for (int i = 0; i < 50; i++) {
            int r = waitpid(p->pid, NULL, WNOHANG);
            if (r == p->pid || (r < 0 && errno == ECHILD)) { p->pid = 0; return; }
            usleep(10000);
        }
        kill(p->pid, SIGKILL);
        while (waitpid(p->pid, NULL, 0) < 0 && errno == EINTR) {}
        p->pid = 0;
    }
}
int zrtc_pcm_open(ZrtcPcm *p, int recording) {
    p->fd = -1; p->pid = 0;
    const char *host = getenv("ZRTC_PCM_HOST");
    if (!host || host[0] != '/') {
        fputs("PCM: ZRTC_PCM_HOST must name the absolute native helper path\n", stderr);
        return -1;
    }
    const char *device = getenv(recording ? "ZRTC_PCM_SOURCE" : "ZRTC_PCM_SINK");
    char *argv[] = {(char *)host, recording ? "record" : "playback", (char *)device, NULL};
    size_t n = 0;
    while (environ[n]) ++n;
    char **envp = calloc(n + 2, sizeof *envp);
    if (!envp) return -1;
    size_t k = 0;
    for (size_t i = 0; i < n; i++)
        if (strncmp(environ[i], "LD_", 3) && strncmp(environ[i], "ZRTC_PCM_READY_FD=", 18))
            envp[k++] = environ[i];
    envp[k] = "ZRTC_PCM_READY_FD=3";
    int data[2], ready[2];
    if (pipe2(data, O_CLOEXEC)) { free(envp); return -1; }
    if (pipe2(ready, O_CLOEXEC)) { close(data[0]); close(data[1]); free(envp); return -1; }
    pid_t parent = getpid();
    pid_t pid = fork();
    if (pid == 0) {
        /* Async-signal-safe child: do not call allocator/unsetenv after fork. */
        /* Do not leave a microphone helper running if the engine crashes. */
        if (prctl(PR_SET_PDEATHSIG, SIGKILL) || getppid() != parent) _exit(126);
        if (dup2(recording ? data[1] : data[0], recording ? 1 : 0) < 0 || dup2(ready[1], 3) < 0)
            _exit(126);
        if (data[0] > 3) close(data[0]);
        if (data[1] > 3) close(data[1]);
        if (ready[0] > 3) close(ready[0]);
        if (ready[1] > 3) close(ready[1]);
        execve(host, argv, envp);
        _exit(127);
    }
    free(envp);
    close(ready[1]);
    close(recording ? data[1] : data[0]);
    p->fd = recording ? data[0] : data[1]; p->pid = pid > 0 ? pid : 0;
    if (pid < 0) { close(ready[0]); zrtc_pcm_close(p); return -1; }
    struct pollfd poll_ready = {ready[0], POLLIN, 0};
    char token = 0;
    int rc;
    do { rc = poll(&poll_ready, 1, 4000); } while (rc < 0 && errno == EINTR);
    int ok = rc > 0 && read(ready[0], &token, 1) == 1 && token == 'R';
    close(ready[0]);
    if (!ok) { zrtc_pcm_close(p); return -1; }
    if (fcntl(p->fd, F_SETFL, O_NONBLOCK) < 0) { zrtc_pcm_close(p); return -1; }
    return 0;
}
int zrtc_pcm_transfer(ZrtcPcm *p, void *buffer, size_t bytes, int recording, const int *stopping) {
    size_t done = 0;
    while (done < bytes && !__atomic_load_n(stopping, __ATOMIC_ACQUIRE)) {
        struct pollfd fd = {p->fd, recording ? POLLIN : POLLOUT, 0};
        int rc = poll(&fd, 1, 100);
        if (rc < 0 && errno == EINTR) continue;
        if (rc < 0 || (fd.revents & (POLLERR | POLLNVAL))) return -1;
        if (!rc) continue;
        ssize_t n = recording ? read(p->fd, (char *)buffer + done, bytes - done)
                              : write(p->fd, (char *)buffer + done, bytes - done);
        if (n < 0 && (errno == EAGAIN || errno == EINTR)) continue;
        if (n <= 0) return -1;
        done += (size_t)n;
    }
    return done == bytes ? 0 : -1;
}
