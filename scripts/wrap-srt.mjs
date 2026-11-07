#!/usr/bin/env node
// Breaks long subtitle lines in .srt files into balanced lines, using the
// same wrapping as the app's "Break long lines" switch. Text and timing are
// not changed otherwise, and a file with no long lines is not rewritten.

import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const require = createRequire(import.meta.url);
const { MAX_LINE_CHARS, wrapSRT } = require('../src/wrap.js');

function printHelp() {
    console.log(`Usage:
  node scripts/wrap-srt.mjs [options] <file.srt>...

Writes <name>.wrapped.srt next to each input.

Options:
  --max-chars <number>   Longest line in characters (default: ${MAX_LINE_CHARS})
  --in-place             Overwrite the input files instead
  --overwrite            Replace existing .wrapped.srt files
  --help                 Show this help`);
}

function parseArgs(argv) {
    const args = { files: [], maxChars: MAX_LINE_CHARS, inPlace: false, overwrite: false, help: false };
    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];
        if (argument === '--help' || argument === '-h') args.help = true;
        else if (argument === '--in-place' || argument === '-i') args.inPlace = true;
        else if (argument === '--overwrite') args.overwrite = true;
        else if (argument === '--max-chars') {
            const value = Number(argv[++i]);
            if (!Number.isInteger(value) || value < 10 || value > 200) throw new Error('--max-chars must be a whole number from 10 to 200');
            args.maxChars = value;
        } else if (argument === '--') {
            args.files.push(...argv.slice(i + 1));
            break;
        }
        else if (argument.startsWith('-')) throw new Error(`Unknown option: ${argument}`);
        else args.files.push(argument);
    }
    return args;
}

// wrapSRT expects LF line endings and empty separator lines, so CRLF and
// whitespace-only lines are cleaned up first. A whitespace-only line ends a
// block, as it does in most players. The BOM and CRLF are put back afterwards.
// Returns null when no line needed wrapping, so the file can stay untouched.
export function wrapSRTFile(content, maxChars = MAX_LINE_CHARS) {
    const bom = content.startsWith('\uFEFF') ? '\uFEFF' : '';
    const eol = content.includes('\r\n') ? '\r\n' : '\n';
    const normalized = content.slice(bom.length).replace(/\r\n?/g, '\n').replace(/^[ \t]+$/gm, '').trim();
    const wrapped = wrapSRT(normalized, maxChars);
    if (wrapped === normalized) return null;
    return bom + `${wrapped}\n`.replace(/\n/g, eol);
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help || args.files.length === 0) {
        printHelp();
        if (!args.help) process.exitCode = 1;
        return;
    }
    // Files are independent and small, so they are read and written at once.
    await Promise.all(args.files.map(async file => {
        try {
            const wrapped = wrapSRTFile(await readFile(file, 'utf8'), args.maxChars);
            if (wrapped === null) {
                console.log(`${file}: no line over ${args.maxChars} characters, left as it is`);
                return;
            }
            const parsed = path.parse(file);
            const output = args.inPlace ? file : path.join(parsed.dir, `${parsed.name}.wrapped${parsed.ext || '.srt'}`);
            // "wx" refuses an existing output, including a symlink planted in its place.
            const flag = args.inPlace || args.overwrite ? 'w' : 'wx';
            await writeFile(output, wrapped, { flag });
            console.log(`${file} -> ${output}`);
        } catch (error) {
            const reason = error.code === 'EEXIST' ? 'output already exists (use --overwrite)' : error.message;
            console.error(`Skipped ${file}: ${reason}`);
            process.exitCode = 1;
        }
    }));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
    main().catch(error => {
        console.error(error.message);
        process.exitCode = 1;
    });
}
