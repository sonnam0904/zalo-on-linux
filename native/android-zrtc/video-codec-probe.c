/* Offline original WebRtcVideoCoding software initialization diagnostic.
 * Pinned allocation size 0xf00: Peer::_init at 0x2d6c05.
 * initialize() is the native non-JNI overload used at 0x2d119f.
 * No camera, Peer call, account configuration or texture helper is involved.
 */
#include <dlfcn.h>
#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <errno.h>
#include <stddef.h>
#include <linux/filter.h>
#include <linux/seccomp.h>
#include <linux/audit.h>
#include <sys/prctl.h>
#include <sys/syscall.h>
#include <string.h>
#include "video-source-linux.h"
static void (*deliver)(void *,const void *);
static void deliver_frame(void *codec,const void *frame) {deliver(codec,frame);}
static unsigned encoded_frames;
static size_t encoded_bytes;
static int output_encoded;
static void unexpected_callback(void) {fputs("Unsupported video diagnostic callback\n",stderr);_exit(79);}
/* SendData 0x39a41a calls callback slot 4 with EncodedImage const&.
 * PayloadRouter arguments verify buffer at 0x28 and length at 0x30. */
static void encoded_callback(void *self,const unsigned char *image) {
    (void)self;
    const void *data;size_t size;
    memcpy(&data,image+0x28,sizeof data);memcpy(&size,image+0x30,sizeof size);
    if(!data || !size || size>10*1024*1024)_exit(80);
    encoded_frames++;encoded_bytes+=size;
    if(output_encoded) {
        const unsigned char *p=data;
        while(size) {
            ssize_t n=write(3,p,size);
            if(n<0 && errno==EINTR)continue;
            if(n<=0)_exit(82);
            p+=n;size-=(size_t)n;
        }
    }
}
static void *sym(void *h,const char *name) {
    void *p=dlsym(h,name);if(!p){fprintf(stderr,"Missing symbol %s\n",name);exit(2);}return p;
}
static int deny_network(void) {
    struct sock_filter code[]={
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,arch)),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,AUDIT_ARCH_X86_64,1,0),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_KILL_PROCESS),
        BPF_STMT(BPF_LD|BPF_W|BPF_ABS,offsetof(struct seccomp_data,nr)),
        BPF_JUMP(BPF_JMP|BPF_JSET|BPF_K,0x40000000,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_socket,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_JUMP(BPF_JMP|BPF_JEQ|BPF_K,__NR_connect,0,1),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ERRNO|EPERM),
        BPF_STMT(BPF_RET|BPF_K,SECCOMP_RET_ALLOW)
    };
    struct sock_fprog p={sizeof code/sizeof code[0],code};
    return prctl(PR_SET_NO_NEW_PRIVS,1,0,0,0)||prctl(PR_SET_SECCOMP,SECCOMP_MODE_FILTER,&p);
}
int main(int argc,char **argv) {
    if((argc!=2 && argc!=3) || (argc==3 && strcmp(argv[2],"--encoded-fd3")) || deny_network())return 2;
    output_encoded=argc==3;
    setbuf(stdout,NULL);alarm(15);
    void *h=dlopen(argv[1],RTLD_NOW|RTLD_LOCAL);
    if(!h){fprintf(stderr,"%s\n",dlerror());return 2;}
    void (*ctor)(void *)=sym(h,"_ZN4zrtc17WebRtcVideoCodingC1Ev");
    void (*dtor)(void *)=sym(h,"_ZN4zrtc17WebRtcVideoCodingD1Ev");
    unsigned char (*init)(void *)=sym(h,"_ZN4zrtc17WebRtcVideoCoding10initializeEv");
    void (*stop)(void *)=sym(h,"_ZN4zrtc17WebRtcVideoCoding4stopEv");
    deliver=sym(h,"_ZN4zrtc17WebRtcVideoCoding12deliverFrameERKN6webrtc10VideoFrameE");
    void (*stats)(void *,int *,int *)=sym(h,"_ZN4zrtc17WebRtcVideoCoding14GetEncodeStatsERiS1_");
    void (*set_callback)(void *,void *)=sym(h,"_ZN4zrtc17WebRtcVideoCoding16registerCallbackEPNS0_25WebRtcVideoCodingCallbackE");
    for(int i=0;i<3;i++) {
        void *codec=calloc(1,0xf00);if(!codec)return 2;
        puts("VIDEO_CODEC: constructing original codec owner");ctor(codec);
        int rc=init(codec);printf("VIDEO_CODEC: software initialize=%d\n",rc);
        if(rc) {
            void *vtable[32];for(unsigned slot=0;slot<32;slot++)vtable[slot]=(void *)unexpected_callback;
            vtable[4]=(void *)encoded_callback;
            struct {void *vtable;} callback={vtable};
            encoded_frames=0;encoded_bytes=0;set_callback(codec,&callback);
            LinuxVideoSource *source=linux_video_source_create(h,deliver_frame,codec);
            const size_t size=640*480*3/2;
            unsigned char *pixels=malloc(size);if(!source || !pixels)return 2;
            memset(pixels,128,size);
            for(int frame=0;frame<60;frame++) {
                // Moving high-contrast pattern survives lossy quantization;
                // a slowly fading flat field can legitimately encode repeats.
                for(int y=0;y<480;y++)for(int x=0;x<640;x++)
                    pixels[y*640+x]=(unsigned char)(32+((x+frame*13)%256)*3/4+((y+frame*7)%64)/4);
                if(linux_video_source_submit(source,pixels,size,640,480,0,(int64_t)frame*33333333))return 3;
                usleep(33333);
            }
            int a=0,b=0;stats(codec,&a,&b);
            printf("VIDEO_CODEC: reported encode stats=%d/%d after 60 synthetic frames\n",a,b);
            printf("VIDEO_CODEC: original encoded callbacks=%u bytes=%zu\n",encoded_frames,encoded_bytes);
            set_callback(codec,NULL);
            linux_video_source_destroy(source);free(pixels);
            if(!encoded_frames || !encoded_bytes)return 81;
        }
        stop(codec);dtor(codec);free(codec);
        if(!rc)return 78;
    }
    dlclose(h);
    puts("PASS native video codec input/init/stop: 3 cycles; remote video remains unverified");return 0;
}
