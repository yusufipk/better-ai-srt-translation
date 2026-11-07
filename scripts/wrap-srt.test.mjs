import assert from 'node:assert/strict';
import test from 'node:test';

import { wrapSRTFile } from './wrap-srt.mjs';

test('splits a long line into two balanced lines and keeps timing', () => {
    const input = '\uFEFF1\n00:00:01,000 --> 00:00:03,000\nThis is a fairly long subtitle line that should be split in two.\n  \n\n2\n00:00:04,000 --> 00:00:05,000\nShort one.\n';
    assert.equal(
        wrapSRTFile(input),
        '\uFEFF1\n00:00:01,000 --> 00:00:03,000\nThis is a fairly long subtitle\nline that should be split in two.\n\n2\n00:00:04,000 --> 00:00:05,000\nShort one.\n'
    );
});

test('respects a custom line length', () => {
    const output = wrapSRTFile('1\n00:00:01,000 --> 00:00:02,000\nOne two three four five six\n', 12);
    assert.ok(output.split('\n').slice(2).every(line => line.length <= 12), output);
});

test('leaves a file with only short lines alone', () => {
    assert.equal(wrapSRTFile('1\n00:00:01,000 --> 00:00:02,000\nShort.\n'), null);
});

test('keeps CRLF and BOM, and finds the text without an index line', () => {
    const output = wrapSRTFile('\uFEFF00:00:01,000 --> 00:00:03,000\r\nThis is a fairly long subtitle line that should be split in two.\r\n');
    assert.equal(output, '\uFEFF00:00:01,000 --> 00:00:03,000\r\nThis is a fairly long subtitle\r\nline that should be split in two.\r\n');
});

test('rewraps RTL lines that use embedding marks without RLM', () => {
    const line = '\u202Bهذا سطر طويل جدا من الترجمة العربية يحتاج إلى أن ينقسم\u202C';
    const output = wrapSRTFile(`1\n00:00:01,000 --> 00:00:03,000\n${line}\n`);
    const text = output.trim().split('\n').slice(2);
    assert.equal(text.length, 2);
    assert.ok(text.every(l => l.startsWith('\u200F\u202B') && l.endsWith('\u202C') && l.slice(2, -1).search(/[\u200F\u202B\u202C]/) === -1), output);
});
