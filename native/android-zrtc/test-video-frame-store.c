#include "video-frame-store.h"
#include <assert.h>
#include <errno.h>
#include <stdio.h>
#include <string.h>
int main(void) {
    unsigned char y[]={1,2,3,4,99,99,5,6,7,8,99,99},u[]={9,10,99},v[]={11,12,99};
    const unsigned char *planes[]={y,u,v};int strides[]={6,3,3};
    unsigned char out[12];int w=0,h=0;uint64_t seq=0,previous;
    assert(video_frame_store_publish(4,2,planes,strides)==-ENOTCONN);
    video_frame_store_start();
    assert(video_frame_store_snapshot(out,sizeof out,&w,&h,&seq)==-ENODATA);
    assert(video_frame_store_publish(3,2,planes,strides)==-EINVAL);
    assert(video_frame_store_publish(4,2,planes,strides)==0);
    memset(y,0,sizeof y); // Native decoder may recycle its planes immediately.
    assert(video_frame_store_snapshot(out,11,&w,&h,&seq)==-ENOBUFS);
    assert(video_frame_store_snapshot(out,12,&w,&h,&seq)==12);
    assert(w==4 && h==2 && seq>0);previous=seq;
    for(int i=0;i<12;i++)assert(out[i]==i+1);
    video_frame_store_stop();
    assert(video_frame_store_snapshot(out,12,&w,&h,&seq)==-ENODATA);
    assert(video_frame_store_publish(4,2,planes,strides)==-ENOTCONN);
    video_frame_store_start();
    assert(video_frame_store_snapshot(out,12,&w,&h,&seq)==-ENODATA);
    assert(video_frame_store_publish(4,2,planes,strides)==0);
    assert(video_frame_store_snapshot(out,12,&w,&h,&seq)==12 && seq>previous);
    video_frame_store_stop();
    puts("PASS I420 mailbox: stride packing, owned copy, size guards, stop/restart isolation");
}
