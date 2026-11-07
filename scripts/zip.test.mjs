import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';

const require = createRequire(import.meta.url);
const { createZip, zipCrc32, zipEntryName } = require('../src/zip.js');

test('computes the standard CRC-32', () => {
    assert.equal(zipCrc32(new TextEncoder().encode('hello')), 0x3610A686);
});

test('entry names cannot climb out of the extraction folder', () => {
    assert.equal(zipEntryName('../../etc/passwd'), 'etc/passwd');
    assert.equal(zipEntryName('/abs\\win\\..\\x.srt'), 'abs/win/x.srt');
    assert.equal(zipEntryName('..'), 'file');
});

test('repeated names get a number and the archive lists every file', () => {
    const zip = createZip([
        { name: 'Bölüm 1_TR.srt', data: 'bir' },
        { name: 'bölüm 1_TR.srt', data: 'iki' },
        { name: 'sezon/ep_TR.srt', data: 'üç' }
    ]);
    const view = new DataView(zip.buffer);
    const end = zip.length - 22;
    assert.equal(view.getUint32(end, true), 0x06054B50);
    assert.equal(view.getUint16(end + 10, true), 3);
    const text = new TextDecoder().decode(zip);
    assert.ok(text.includes('bölüm 1_TR (2).srt'));
    assert.ok(text.includes('sezon/ep_TR.srt'));
});
