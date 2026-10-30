'use strict';

const {readFile, writeFile} = require('node:fs/promises');

function invoke(addon, method, options) {
    return new Promise((resolve, reject) => {
        addon[method](options, (error, data, status) => {
            if (error || status !== 1) {
                const failure = new Error('jxlDecompressMulti error');
                failure.code = status;
                reject(failure);
            } else resolve(data);
        });
    });
}

// The desktop consumer expects one descriptor per task, including files written
// to outputPath. The Linux addon's single-image decoder only returns JPEG bytes.
module.exports = async function decompressMulti(addon, options = {}) {
    const buffer = options.buffer ?? await readFile(options.localPath);
    const info = await invoke(addon, 'getJxlInfo', {buffer});
    const results = [];
    const decoded = new Map();
    for (const task of options.tasks || [{}]) {
        let maxWidth = info.width, maxHeight = info.height;
        if (task.width > 0 && task.height > 0) {
            maxWidth = task.width;
            maxHeight = task.height;
        }
        if (task.maxWidth > 0) maxWidth = Math.min(maxWidth, task.maxWidth);
        if (task.maxHeight > 0) maxHeight = Math.min(maxHeight, task.maxHeight);
        const scale = Math.min(1, maxWidth / info.width, maxHeight / info.height);
        const width = Math.max(1, Math.round(info.width * scale));
        const height = Math.max(1, Math.round(info.height * scale));
        const key = `${width}x${height}`;
        if (!decoded.has(key)) {
            decoded.set(key, await invoke(addon, 'jxlToJpeg', {
                buffer, quality: options.quality ?? 80,
                outputWidth: maxWidth, outputHeight: maxHeight,
            }));
        }
        const jpeg = decoded.get(key);
        const output_path = task.outputPath || '';
        if (output_path) await writeFile(output_path, jpeg);
        results.push({data: output_path ? undefined : jpeg, width, height,
            output_path, size: jpeg.length});
    }
    return {data: results, status_code: 1};
};
