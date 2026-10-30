/* Version-specific Linux adaptation of an Android-only prerequisite.
 * The original ELF on disk is never modified. Apply once, before worker start.
 * Audio-only mode does not use EGL; all other modes retain the original check.
 * This does NOT skip any audio/RTP/worker initialization or force success.
 */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <stdint.h>
#include <stdio.h>
#include <string.h>
#include <sys/mman.h>
#include <unistd.h>

static void absolute_jump(unsigned char *at, const void *target) {
    const unsigned char instruction[6] = {0xff, 0x25, 0, 0, 0, 0};
    memcpy(at, instruction, 6);
    uintptr_t address = (uintptr_t)target;
    memcpy(at + 6, &address, 8);
}
int zrtc_linux_voice_platform(void *library) {
    unsigned char *initialize = dlsym(library, "_ZN4zrtc4Peer10initializeEv");
    if (!initialize) return -1;
    /* SHA-pinned ELF: cmpq $0,0x850(%rdi); je initialize+0x272. */
    const unsigned char expected[14] = {0x48,0x83,0xbf,0x50,0x08,0,0,0,
                                       0x0f,0x84,0x0b,0x02,0,0};
    unsigned char *site = initialize + 0x59;
    if (memcmp(site, expected, sizeof expected)) {
        fputs("VOICE_PLATFORM: unsupported instruction sequence; refusing adaptation\n", stderr);
        return -1;
    }
    long page_size = sysconf(_SC_PAGESIZE);
    if (page_size <= 0) return -1;
    unsigned char *code = mmap(NULL, (size_t)page_size, PROT_READ | PROT_WRITE,
                               MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (code == MAP_FAILED) return -1;
    /* cmp [peer+0x70],1; je pass; original cmp EGL; jne pass;
       absolute jump original failure; pass: jump original continuation.
       No GPRs or stack entries are clobbered. */
    const unsigned char prefix[16] = {0x83,0x7f,0x70,0x01, 0x74,0x18,
        0x48,0x83,0xbf,0x50,0x08,0,0,0, 0x75,0x0e};
    memcpy(code, prefix, sizeof prefix);
    absolute_jump(code + 16, initialize + 0x272);
    absolute_jump(code + 30, initialize + 0x67);
    if (mprotect(code, (size_t)page_size, PROT_READ | PROT_EXEC)) {
        munmap(code, (size_t)page_size); return -1;
    }
    uintptr_t first = (uintptr_t)site & ~((uintptr_t)page_size - 1);
    uintptr_t last = ((uintptr_t)site + 13) & ~((uintptr_t)page_size - 1);
    size_t span = last - first + (size_t)page_size;
    if (mprotect((void *)first, span, PROT_READ | PROT_WRITE)) {
        munmap(code, (size_t)page_size); return -1;
    }
    absolute_jump(site, code);
    if (mprotect((void *)first, span, PROT_READ | PROT_EXEC)) {
        /* Never continue into a partly installed adaptation. */
        perror("VOICE_PLATFORM executable protection"); _exit(2);
    }
    puts("VOICE_PLATFORM: EGL prerequisite retained except for native audio-only mode");
    return 0;
}
