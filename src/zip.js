// Minimal ZIP writer for the "Download all" button. Files are stored without
// compression (subtitles are small), so it needs no library. Shared by the
// browser app (loaded as a classic script before app.js) and the tests
// (loaded through require).

const ZIP_CRC_TABLE = (() => {
    const table = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
        let c = n;
        for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
        table[n] = c >>> 0;
    }
    return table;
})();

function zipCrc32(bytes) {
    let crc = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) crc = ZIP_CRC_TABLE[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
    return (crc ^ 0xFFFFFFFF) >>> 0;
}

// Turns a relative path into a safe entry name: forward slashes only, no
// leading slash, no "." or ".." segments, so extracting the archive can never
// write outside the folder it is extracted into.
function zipEntryName(path) {
    const parts = String(path).replace(/\\/g, '/').split('/')
        .map(part => part.replace(/[\u0000-\u001F]/g, '').trim())
        .filter(part => part && part !== '.' && part !== '..');
    return parts.join('/') || 'file';
}

// Builds a ZIP archive from [{ name, data }] where data is a string (written
// as UTF-8) or a Uint8Array. Names are made safe and unique; a repeated name
// gets " (2)", " (3)" before its extension. Returns a Uint8Array.
function createZip(files, date = new Date()) {
    // The classic format counts entries in 16 bits and sizes in 32 bits.
    if (files.length > 0xFFFF) throw new Error('Too many files for one ZIP archive');
    const encoder = new TextEncoder();
    const time = (date.getHours() << 11) | (date.getMinutes() << 5) | Math.floor(date.getSeconds() / 2);
    const day = ((Math.max(date.getFullYear(), 1980) - 1980) << 9) | ((date.getMonth() + 1) << 5) | date.getDate();
    const used = new Set();
    const locals = [];
    const centrals = [];
    let offset = 0;

    for (const file of files) {
        let name = zipEntryName(file.name);
        if (used.has(name.toLowerCase())) {
            const dot = name.lastIndexOf('.');
            const slash = name.lastIndexOf('/');
            const stem = dot > slash ? name.slice(0, dot) : name;
            const ext = dot > slash ? name.slice(dot) : '';
            let n = 2;
            while (used.has(`${stem} (${n})${ext}`.toLowerCase())) n++;
            name = `${stem} (${n})${ext}`;
        }
        used.add(name.toLowerCase());

        const nameBytes = encoder.encode(name);
        const data = typeof file.data === 'string' ? encoder.encode(file.data) : file.data;
        const crc = zipCrc32(data);

        const local = new DataView(new ArrayBuffer(30));
        local.setUint32(0, 0x04034B50, true);
        local.setUint16(4, 20, true);         // version needed
        local.setUint16(6, 0x0800, true);     // UTF-8 names
        local.setUint16(8, 0, true);          // stored
        local.setUint16(10, time, true);
        local.setUint16(12, day, true);
        local.setUint32(14, crc, true);
        local.setUint32(18, data.length, true);
        local.setUint32(22, data.length, true);
        local.setUint16(26, nameBytes.length, true);
        local.setUint16(28, 0, true);
        locals.push(new Uint8Array(local.buffer), nameBytes, data);

        const central = new DataView(new ArrayBuffer(46));
        central.setUint32(0, 0x02014B50, true);
        central.setUint16(4, 20, true);       // version made by
        central.setUint16(6, 20, true);
        central.setUint16(8, 0x0800, true);
        central.setUint16(10, 0, true);
        central.setUint16(12, time, true);
        central.setUint16(14, day, true);
        central.setUint32(16, crc, true);
        central.setUint32(20, data.length, true);
        central.setUint32(24, data.length, true);
        central.setUint16(28, nameBytes.length, true);
        central.setUint32(42, offset, true);  // the other fields stay 0
        centrals.push(new Uint8Array(central.buffer), nameBytes);

        offset += 30 + nameBytes.length + data.length;
    }

    const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
    if (offset + centralSize > 0xFFFFFFFF) throw new Error('The files are too large for one ZIP archive');
    const end = new DataView(new ArrayBuffer(22));
    end.setUint32(0, 0x06054B50, true);
    end.setUint16(8, files.length, true);
    end.setUint16(10, files.length, true);
    end.setUint32(12, centralSize, true);
    end.setUint32(16, offset, true);

    const parts = [...locals, ...centrals, new Uint8Array(end.buffer)];
    const out = new Uint8Array(parts.reduce((sum, part) => sum + part.length, 0));
    let position = 0;
    for (const part of parts) {
        out.set(part, position);
        position += part.length;
    }
    return out;
}

if (typeof module === 'object' && module.exports) {
    module.exports = { createZip, zipCrc32, zipEntryName };
}
