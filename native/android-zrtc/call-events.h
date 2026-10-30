#pragma once
#include <stddef.h>
/* Values are borrowed only for the duration of the synchronous sink callback.
 * The IPC owner must copy them before returning and must not log session data. */
typedef struct {
    char type; /* I=int, Z=boolean, S=string; a null string stays NULL */
    int integer;
    const char *string;
} ZrtcEventValue;
typedef void (*ZrtcEventSink)(void *opaque, const char *name,
                            const ZrtcEventValue *values, size_t count);
const char *zrtc_event_signature(const char *name);
const char *zrtc_event_types(const char *name);
