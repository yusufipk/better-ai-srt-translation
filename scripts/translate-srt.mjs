#!/usr/bin/env node

// Command-line version of the web app. Parsing, chunking, the system prompt,
// marker handling mirror src/app.js and RTL formatting mirrors src/wrap.js;
// keep them in sync.

import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const DEFAULT_MODEL_GEMINI = 'gemini-3.1-flash-lite';
const DEFAULT_MODEL_OPENROUTER = 'google/gemini-3.1-flash-lite';
const PROVIDERS = ['gemini', 'openrouter', 'openai'];
// The custom server gets its own variable: a real OPENAI_API_KEY exported for
// other tools must never be sent to an arbitrary --base-url.
const API_KEY_ENV = { gemini: 'GEMINI_API_KEY', openrouter: 'OPENROUTER_API_KEY', openai: 'SRT_OPENAI_API_KEY' };
// Same limits as the web app's number inputs.
const CHUNK_SIZE_RANGE = [10, 200];
const PARALLEL_RANGE = [1, 100];
// A bad key, an unknown model or a malformed request fails the same way for
// every chunk (402 is OpenRouter out of credits), so retrying or carrying on
// only burns requests.
const FATAL_STATUSES = new Set([400, 401, 402, 403, 404]);

// Server error text is printed to the terminal; drop control characters so a
// response cannot inject escape sequences.
function printable(text) {
    return String(text).replace(/[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g, '');
}
const DEFAULT_CHUNK_SIZE = 20;
const DEFAULT_PARALLEL = 5;
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;
const REQUEST_TIMEOUT_MS = 30000;
// Self-hosted servers often run one request at a time, so queued chunks wait longer.
const CUSTOM_SERVER_TIMEOUT_MS = 120000;
const THINKING_LEVELS = ['low', 'medium', 'high'];
// Gemini 2.5 takes a token budget instead of a level.
const GEMINI_THINKING_BUDGETS = { low: 1024, medium: 8192, high: 24576 };
const OPENROUTER_REFERER = 'https://github.com/yusufipk/better-ai-srt-translation';

// Returns the chat completions URL for a base URL such as ".../v1", or null if
// it is not an http(s) URL. Same rules as chatCompletionsUrl() in src/app.js.
export function chatCompletionsUrl(baseUrl) {
    let input = baseUrl.trim();
    // Allow "localhost:11434/v1" without a scheme, but only for this machine,
    // so a remote server is never silently reached over plain http.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(input)) {
        input = `http://${input}`;
    }
    let url;
    try {
        url = new URL(input);
    } catch {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // Keys go in --api-key or SRT_OPENAI_API_KEY, never in the URL where logs would show them.
    if (url.username || url.password) return null;
    const pathname = url.pathname.replace(/\/+$/, '');
    url.pathname = pathname.endsWith('/chat/completions') ? pathname : `${pathname}/chat/completions`;
    return url.toString();
}

export function parseSRT(content) {
    const blocks = [];
    const lines = content.split(/\r?\n/);
    let currentBlock = null;

    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (/^\d+$/.test(line)) {
            if (currentBlock) blocks.push(currentBlock);
            currentBlock = { index: Number.parseInt(line, 10), timestamp: '', text: [] };
        } else if (currentBlock && line.includes('-->')) {
            currentBlock.timestamp = line;
        } else if (currentBlock && line !== '') {
            currentBlock.text.push(line);
        }
    }

    if (currentBlock) blocks.push(currentBlock);
    return blocks;
}

export function createSmartChunks(blocks, targetSize) {
    const chunks = [];
    let currentChunk = [];

    for (const block of blocks) {
        currentChunk.push(block);
        if (currentChunk.length < targetSize) continue;

        let splitIndex = -1;
        for (let i = currentChunk.length - 1; i >= Math.max(0, currentChunk.length - 10); i--) {
            if (/[.!?][\s"']*$/.test(currentChunk[i].text.join(' '))) {
                splitIndex = i;
                break;
            }
        }

        if (splitIndex === -1) {
            chunks.push([...currentChunk]);
            currentChunk = [];
        } else {
            chunks.push(currentChunk.slice(0, splitIndex + 1));
            currentChunk = currentChunk.slice(splitIndex + 1);
        }
    }

    if (currentChunk.length > 0) chunks.push(currentChunk);
    return chunks;
}

export function blocksToSRT(blocks) {
    return blocks.map((block) => (
        `${block.index}\n${block.timestamp}\n${block.text.join('\n')}`
    )).join('\n\n');
}

export function buildSystemPrompt(targetLanguage, customInstructions = '') {
    let prompt = `You are an expert subtitle translator for ${targetLanguage}.

INPUT: Lines starting with markers [B1], [B2], etc.

PRIORITY ORDER (highest to lowest):
1. LINE STRUCTURE (MANDATORY): Each [B#] line stays separate. Never merge or swap content between lines.
2. NATURAL TRANSLATION: Translate idiomatically, not word-for-word. Omit unnecessary pronouns if the language allows it.
3. WORD COUNT (SOFT): Try to keep similar word count per line, but naturalness comes first.

RULES:
- Keep [B#] markers at the start of each output line
- Return EXACTLY the same number of lines as input
- Do NOT add any annotations, word counts, or comments
- Just output the translated text with markers, nothing else

EXAMPLE:
Input:
[B1] I don't think OpenAI will
[B2] be around in 5 years.

Output:
[B1] OpenAI'ın var olacağını
[B2] 5 yıl içinde sanmıyorum.

CRITICAL: [B1] → [B1], [B2] → [B2]. Never shift content.`;

    if (['Arabic', 'Persian'].includes(targetLanguage)) {
        prompt += `

IMPORTANT FOR RIGHT-TO-LEFT TRANSLATION:
- You MUST use correct RTL punctuation (e.g. use Arabic/Persian comma '،' instead of English ',', and Arabic/Persian question mark '؟' instead of English '?').
- Do NOT translate English names, technical terms, or code if they are best kept in English, but ensure they are embedded naturally in the RTL structure.`;
    }

    if (customInstructions.trim()) {
        prompt += `\n\nMANDATORY USER INSTRUCTIONS (MUST FOLLOW):\n${customInstructions.trim()}\n\nYou MUST follow these instructions exactly. They override any conflicting rules.`;
    }

    return prompt;
}

export function extractTextWithMarkers(blocks) {
    return blocks.map((block, i) => `[B${i + 1}] ${block.text.join(' ')}`).join('\n');
}

export function parseMarkedTranslation(blocks, translatedText) {
    return blocks.map((block, i) => {
        const markerStart = `[B${i + 1}]`;
        const markerEnd = `[B${i + 2}]`;
        const startIndex = translatedText.indexOf(markerStart);

        if (startIndex === -1) {
            return { index: block.index, timestamp: block.timestamp, text: [block.text.join(' ')] };
        }

        const textStart = startIndex + markerStart.length;
        const endIndex = i === blocks.length - 1
            ? translatedText.length
            : translatedText.indexOf(markerEnd);
        const textEnd = endIndex === -1 ? translatedText.length : endIndex;

        return {
            index: block.index,
            timestamp: block.timestamp,
            text: [translatedText.substring(textStart, textEnd).trim()]
        };
    });
}

export function formatTranslatedText(text, targetLanguage) {
    if (!['Arabic', 'Persian'].includes(targetLanguage)) return text;

    const rlm = '\u200F';
    const rle = '\u202B';
    const pdf = '\u202C';
    return text
        .replace(/(?<!\d),|,(?!\d)/g, '،')
        .replace(/\?/g, '؟')
        .replace(/;/g, '؛')
        .split('\n')
        .map((line) => {
            if (line.trim() === '') return line;
            let formatted = line;
            if (!formatted.startsWith(rle)) formatted = rle + formatted;
            if (!formatted.endsWith(pdf)) formatted += pdf;
            if (!formatted.startsWith(rlm)) formatted = rlm + formatted;
            return formatted;
        })
        .join('\n');
}

class APIError extends Error {
    constructor(status, message, details = null, retryAfterSeconds = null) {
        super(message);
        this.name = 'APIError';
        this.status = status;
        this.details = details;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function getRetryDelay(error, attempt) {
    if (error.status !== 429) return RETRY_DELAY_MS * (2 ** (attempt - 1));

    let retrySeconds = error.retryAfterSeconds ?? 60;
    if (Array.isArray(error.details)) {
        const retryInfo = error.details.find((item) => (
            item['@type'] === 'type.googleapis.com/google.rpc.RetryInfo'
        ));
        const match = retryInfo?.retryDelay?.match(/^(\d+(?:\.\d+)?)\s*s$/i);
        if (match) retrySeconds = Number.parseFloat(match[1]);
    }
    return (retrySeconds + 2) * 1000;
}

async function fetchWithTimeout(url, options, timeoutMs) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
    try {
        return await fetch(url, { ...options, signal: controller.signal });
    } catch (error) {
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        }
        throw error;
    } finally {
        clearTimeout(timeoutId);
    }
}

// Request fields for a thinking level; empty when none was given.
// Same mapping as thinkingRequestFields() in src/app.js.
export function thinkingRequestFields(provider, model, level) {
    if (!THINKING_LEVELS.includes(level)) return {};
    if (provider === 'openrouter') return { reasoning: { effort: level } };
    if (provider === 'openai') return { reasoning_effort: level };
    // Gemini 3 and later take a level. 2.5 and the "-latest" aliases take a
    // budget, which newer models also still accept. Older Gemini and Gemma
    // models cannot think, so they get nothing.
    if (/gemini-([3-9]|\d{2,})/.test(model)) return { thinkingConfig: { thinkingLevel: level } };
    if (/gemini-2\.5|gemini-.*latest/.test(model)) return { thinkingConfig: { thinkingBudget: GEMINI_THINKING_BUDGETS[level] } };
    return {};
}

async function translateChunk(chunk, index, options) {
    const { apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinking: thinkingLevel } = options;
    const thinking = thinkingRequestFields(provider, model, thinkingLevel);
    // Thinking adds time before the first token, so give it the longer timeout too.
    const longTimeout = provider === 'openai' || Boolean(thinkingLevel);
    const markedText = extractTextWithMarkers(chunk);
    const systemPrompt = buildSystemPrompt(targetLanguage, customInstructions);
    const openAIStyle = provider !== 'gemini';
    let response;

    if (openAIStyle) {
        const headers = { 'Content-Type': 'application/json' };
        // Self-hosted servers often run without auth; send a key only if one is set.
        if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
        if (provider === 'openrouter') {
            headers['HTTP-Referer'] = OPENROUTER_REFERER;
            headers['X-Title'] = 'Better AI SRT Translation';
        }
        const url = provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : endpoint;
        const timeoutMs = longTimeout ? CUSTOM_SERVER_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
        response = await fetchWithTimeout(url, {
            method: 'POST',
            headers,
            body: JSON.stringify({
                model,
                messages: [
                    { role: 'system', content: systemPrompt },
                    { role: 'user', content: markedText }
                ],
                // OpenAI reasoning models reject any temperature but the default.
                ...(thinkingLevel ? {} : { temperature: 0.3 }),
                ...thinking
            })
        }, timeoutMs);
    } else {
        response = await fetchWithTimeout(
            `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
            {
                method: 'POST',
                // The header keeps the key out of URLs that proxies and error reports may log.
                headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
                body: JSON.stringify({
                    contents: [{ role: 'user', parts: [{ text: markedText }] }],
                    systemInstruction: { parts: [{ text: systemPrompt }] },
                    generationConfig: { temperature: 0.3, ...thinking }
                })
            },
            longTimeout ? CUSTOM_SERVER_TIMEOUT_MS : REQUEST_TIMEOUT_MS
        );
    }

    if (!response.ok) {
        const errorText = await response.text();
        let message = errorText;
        let details = null;
        try {
            const errorObject = JSON.parse(errorText);
            if (errorObject.error) {
                message = errorObject.error.message || errorText;
                details = errorObject.error.details || null;
            }
        } catch {
            // Keep the plain-text response as the error message.
        }
        // OpenAI-style servers announce rate-limit cooldowns in Retry-After (seconds).
        const retryAfter = Number.parseFloat(response.headers.get('retry-after'));
        throw new APIError(response.status, `Chunk ${index + 1}: ${message}`, details,
            Number.isFinite(retryAfter) ? retryAfter : null);
    }

    const data = await response.json();
    const translatedText = openAIStyle
        ? data.choices?.[0]?.message?.content
        : data.candidates?.[0]?.content?.parts?.[0]?.text;
    if (!translatedText) {
        throw new Error(`Chunk ${index + 1}: API returned an empty or invalid response`);
    }

    const translatedBlocks = parseMarkedTranslation(chunk, translatedText);
    return translatedBlocks.map((block) => (
        `${block.index}\n${block.timestamp}\n${formatTranslatedText(block.text.join('\n'), targetLanguage)}`
    )).join('\n\n');
}

async function translateChunkWithRetry(chunk, index, options) {
    let lastError;
    let attempts = MAX_RETRIES;

    for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
            return await translateChunk(chunk, index, options);
        } catch (error) {
            lastError = error;
            if (FATAL_STATUSES.has(error.status)) break;
            if (attempt === attempts) break;
            if (error.status === 429) attempts = Math.max(attempts, 8);
            const delay = getRetryDelay(error, attempt);
            console.warn(`  Chunk ${index + 1} failed (${printable(error.message)}); retrying in ${Math.ceil(delay / 1000)}s...`);
            await sleep(delay);
        }
    }

    throw lastError;
}

async function translateBlocks(blocks, options) {
    const chunks = createSmartChunks(blocks, options.chunkSize);
    const results = new Array(chunks.length);
    let nextChunk = 0;
    let failed = 0;
    let fatalError = null;

    async function worker() {
        while (!fatalError) {
            const index = nextChunk++;
            if (index >= chunks.length) return;
            try {
                results[index] = await translateChunkWithRetry(chunks[index], index, options);
                console.log(`  Chunk ${index + 1}/${chunks.length} translated`);
            } catch (error) {
                if (FATAL_STATUSES.has(error.status)) {
                    fatalError ||= error;
                    return;
                }
                failed++;
                results[index] = blocksToSRT(chunks[index]);
                console.error(`  Chunk ${index + 1}/${chunks.length} failed; original text kept: ${printable(error.message)}`);
            }
        }
    }

    const workerCount = Math.min(options.parallel, chunks.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    if (fatalError) {
        throw new Error(`${printable(fatalError.message)} (HTTP ${fatalError.status}; stopped without writing this file)`);
    }
    return { srt: results.join('\n\n'), failed, total: chunks.length };
}

function parseArgs(argv) {
    const args = {
        provider: 'gemini',
        output: 'translated',
        chunkSize: DEFAULT_CHUNK_SIZE,
        parallel: DEFAULT_PARALLEL,
        instructions: '',
        overwrite: false
    };
    const valueOptions = new Set([
        '--input', '--output', '--api-key', '--provider', '--model', '--base-url',
        '--language', '--target-language', '--chunk-size', '--parallel', '--instructions', '--thinking'
    ]);

    for (let i = 0; i < argv.length; i++) {
        const argument = argv[i];
        if (argument === '--help' || argument === '-h') args.help = true;
        else if (argument === '--overwrite') args.overwrite = true;
        else if (valueOptions.has(argument)) {
            const value = argv[++i];
            if (!value || value.startsWith('--')) throw new Error(`${argument} requires a value`);
            const key = argument.slice(2).replace(/-([a-z])/g, (_, letter) => letter.toUpperCase());
            args[key] = value;
        } else {
            throw new Error(`Unknown option: ${argument}`);
        }
    }

    if (args.chunkSize !== undefined) args.chunkSize = Number.parseInt(args.chunkSize, 10);
    if (args.parallel !== undefined) args.parallel = Number.parseInt(args.parallel, 10);
    if (args.thinking !== undefined && !THINKING_LEVELS.includes(args.thinking)) {
        throw new Error(`--thinking must be one of: ${THINKING_LEVELS.join(', ')}`);
    }
    const inRange = (value, [min, max]) => Number.isInteger(value) && value >= min && value <= max;
    if (!inRange(args.chunkSize, CHUNK_SIZE_RANGE)) throw new Error(`--chunk-size must be a whole number from ${CHUNK_SIZE_RANGE.join(' to ')}`);
    if (!inRange(args.parallel, PARALLEL_RANGE)) throw new Error(`--parallel must be a whole number from ${PARALLEL_RANGE.join(' to ')}`);
    return args;
}

function printHelp() {
    console.log(`Usage:
  node scripts/translate-srt.mjs --input <file-or-directory> --language <language> [options]

Options:
  --input <path>              An .srt file or directory containing .srt files (required)
  --output <directory>        Output directory (default: translated)
  --language <name>           Target language, for example Turkish (required)
  --provider <name>           gemini, openrouter or openai (default: gemini)
  --base-url <url>            Server for --provider openai, e.g. http://localhost:11434/v1
  --model <name>              Model name (required for openai, otherwise a default is used)
  --api-key <key>             API key (prefer GEMINI_API_KEY, OPENROUTER_API_KEY or SRT_OPENAI_API_KEY;
                              optional for openai, and OPENAI_API_KEY is deliberately not read).
                              Use https for any server not on this machine.
  --chunk-size <number>       Subtitle blocks per request, 10 to 200 (default: 20)
  --parallel <number>         Concurrent requests, 1 to 100 (default: 5)
  --instructions <text>       Additional translation instructions
  --thinking <level>          low, medium or high (default: the model's own setting)
  --overwrite                 Replace existing output files
  --help                      Show this help

Examples:
  GEMINI_API_KEY=... node scripts/translate-srt.mjs --input ./subs --output ./translated --language Turkish
  OPENROUTER_API_KEY=... node scripts/translate-srt.mjs --input movie.srt --language Turkish --provider openrouter
  node scripts/translate-srt.mjs --input movie.srt --language Turkish --provider openai --base-url localhost:11434/v1 --model llama3.1
`);
}

async function getInputFiles(inputPath) {
    const inputStat = await stat(inputPath);
    if (inputStat.isFile()) {
        if (!inputPath.toLowerCase().endsWith('.srt')) throw new Error('Input file must have an .srt extension');
        return [inputPath];
    }
    const names = await readdir(inputPath);
    return names
        .filter((name) => name.toLowerCase().endsWith('.srt'))
        .sort()
        .map((name) => path.join(inputPath, name));
}

function languageSlug(language) {
    return language.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'translated';
}

async function main() {
    const args = parseArgs(process.argv.slice(2));
    if (args.help) {
        printHelp();
        return;
    }
    if (!args.input) throw new Error('--input is required');
    if (!args.language && !args.targetLanguage) throw new Error('--language is required');
    const targetLanguage = args.language || args.targetLanguage;
    if (!PROVIDERS.includes(args.provider)) throw new Error(`--provider must be one of: ${PROVIDERS.join(', ')}`);

    const envKey = API_KEY_ENV[args.provider];
    const apiKey = (args.apiKey || process.env[envKey] || '').trim();
    let endpoint = null;
    let model = args.model;
    if (args.provider === 'openai') {
        if (!args.baseUrl) throw new Error('--base-url is required with --provider openai');
        endpoint = chatCompletionsUrl(args.baseUrl);
        if (!endpoint) throw new Error('--base-url must be an http(s) URL without a username or password');
        if (!model) throw new Error('--model is required with --provider openai');
    } else {
        if (!apiKey) throw new Error(`An API key is required. Use --api-key or ${envKey}.`);
        model ||= args.provider === 'openrouter' ? DEFAULT_MODEL_OPENROUTER : DEFAULT_MODEL_GEMINI;
    }

    const inputFiles = await getInputFiles(path.resolve(args.input));
    if (inputFiles.length === 0) throw new Error('No .srt files found in the input path');
    const outputDirectory = path.resolve(args.output);
    const outputFor = (inputFile) => path.join(
        outputDirectory,
        `${path.basename(inputFile, path.extname(inputFile))}_${languageSlug(targetLanguage)}.srt`
    );

    // Check every output path before the first request, so a batch never pays
    // for translations it then refuses to save. "ep1.srt" and "ep1.SRT" would
    // both write ep1_<language>.srt, so catch clashes inside the batch too.
    const seen = new Map();
    for (const inputFile of inputFiles) {
        const outputFile = outputFor(inputFile);
        if (seen.has(outputFile)) {
            throw new Error(`${path.basename(seen.get(outputFile))} and ${path.basename(inputFile)} would both be saved as ${outputFile}`);
        }
        seen.set(outputFile, inputFile);
    }
    if (!args.overwrite) {
        for (const inputFile of inputFiles) {
            const outputFile = outputFor(inputFile);
            const exists = await stat(outputFile).then(() => true, (error) => {
                if (error.code === 'ENOENT') return false;
                throw error;
            });
            if (exists) throw new Error(`Output already exists: ${outputFile}. Use --overwrite to replace it.`);
        }
    }
    await mkdir(outputDirectory, { recursive: true });
    if (endpoint) console.log(`Sending requests to ${endpoint}`);

    let totalFailed = 0;
    for (const inputFile of inputFiles) {
        const blocks = parseSRT(await readFile(inputFile, 'utf8'));
        if (blocks.length === 0) {
            console.warn(`Skipping ${path.basename(inputFile)}: no subtitle blocks found`);
            continue;
        }

        console.log(`Translating ${path.basename(inputFile)} (${blocks.length} blocks)...`);
        const result = await translateBlocks(blocks, {
            apiKey,
            model,
            provider: args.provider,
            endpoint,
            targetLanguage,
            customInstructions: args.instructions,
            thinking: args.thinking,
            chunkSize: args.chunkSize,
            parallel: args.parallel
        });
        const outputFile = outputFor(inputFile);
        await writeFile(outputFile, `${result.srt}\n`, 'utf8');
        console.log(`  Saved ${outputFile}`);
        totalFailed += result.failed;
    }

    if (totalFailed > 0) {
        throw new Error(`${totalFailed} chunk(s) failed; original subtitle text was kept for those chunks`);
    }
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    main().catch((error) => {
        console.error(`Error: ${printable(error.message)}`);
        process.exitCode = 1;
    });
}
