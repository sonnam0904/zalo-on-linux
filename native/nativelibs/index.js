let arch;
var instance = module.exports = {
    fileUtils: () => {
        return require('./file-utils/index.js');
    },
    winUtils: () => {
        return require('./win-utils/index.js');
    },
    zcall: () => {
        return require('./zcall/index.js');
    },
    sqlite3: () => {
        return require('./sqlite3/index.js');
    },
    dbUtils: () => {
        return require('./db-cross-v4/dist/binding.js');
    },
    v8Profiles: () => {
        return require('./v8-profiles/index.js');
    },
    zimage: (options) => {
        return require('./zimage/index.js')(options)
    },
    zaloLogger: () => {
        return require('./logger/index.js');
    },
    zjxl: () => {
        return require('./zjxl/index.js');
    },
    zwalker: () => {
        return require('./zwalker/index.js');
    },
    zfile: () => {
        return require('./zfile/index.js');
    },
    fileUtilities: () => {
        try {
            const utilities = require('./file-utilities/index.js');
            // The Linux build has no directory walker of its own, so borrow the
            // native one. getDirectorySize* is what the storage screens call;
            // the values are identical to the JS walk, only faster.
            try {
                const native = require('./nativedirstat/index.js');
                if (native.usingNative()) {
                    utilities.getDirectorySizeSync = (dir, options) => native.getDirectorySizeSync(dir, options);
                    utilities.getDirectorySizeAsync = (dir, options) => native.getDirectorySizeAsync(dir, options);
                }
            } catch (error) {}
            return utilities;
        } catch (error) {
            return {};
        }
    },
    mp4thumb: () => {
        return require('./mp4thumb/index.js');
    }
}
//////////////////////////////
function test() {
    //if(instance.officeThumbnail().generate_preview.constructor === Function){
    //console.log('office-thumbnail OK');
    //}
    //instance.zcall().test();
    instance.zimage().then(console.error).catch(console.error);
}
// test();