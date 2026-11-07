// Subtitle line wrapping, shared by the browser app (loaded as a classic
// script before app.js) and the wrap-srt CLI (loaded through require).

const RLM = '\u200F';
const RLE = '\u202B';
const PDF = '\u202C';
// Netflix and BBC style guides cap a subtitle line at about 42 characters.
const MAX_LINE_CHARS = 42;

// Wraps a line in RLE/PDF and prepends RLM so players such as VLC lay out
// Arabic and Persian text right to left.
function formatRTLLine(line) {
    if (line.trim() === '') return line;
    let formatted = line;
    if (!formatted.startsWith(RLE)) formatted = RLE + formatted;
    if (!formatted.endsWith(PDF)) formatted += PDF;
    if (!formatted.startsWith(RLM)) formatted = RLM + formatted;
    return formatted;
}

// Formatting tags: HTML-style tags that start with a letter (so "a < b" is
// text) and ASS override blocks such as {\an8}.
const TAG_PATTERN = '<\\/?[A-Za-z][^<>]*>|\\{\\\\[^}]*\\}';
const TAGS = new RegExp(TAG_PATTERN, 'g');
// Words split on ordinary whitespace only: no-break spaces (French "?"
// spacing) stay, and a tag with spaces inside stays one word.
const WORDS = new RegExp(`(?:${TAG_PATTERN}|[^ \\t\\r\\n])+`, 'g');
const LEADING_DASH = new RegExp(`^(?:${TAG_PATTERN})*-`);
// A new speaker starts at " - " only after a finished sentence, so a
// parenthetical dash inside one sentence stays where it is.
const SPEAKER_BREAK = new RegExp(`(?<=[.!?\\u2026]["'\\u201D\\u00BB)]*(?:${TAG_PATTERN})*)[ \\t]+(?=(?:${TAG_PATTERN})*-[ \\t])`);
const ABBREVIATION = /(?:^|\s)(?:Mr|Mrs|Ms|Dr|Prof|St|Jr|Sr|vs|etc|Nr)\.$/i;

// Length as shown on screen: tags, bidi marks and combining marks (Arabic
// vowel signs, Devanagari and Thai diacritics) take no space of their own.
function visibleLength(text) {
    return Array.from(text.replace(TAGS, '').replace(/[\u200E\u200F\u202A-\u202E]|\p{M}/gu, '')).length;
}

// A line of only digits would read as a block number when the file is loaded again.
function isNumberLine(line) {
    return /^\d+$/.test(line);
}

// Breaks one line into as few lines as fit maxChars, keeping them about
// equally long. Two-line splits prefer a break after punctuation. A dash
// standing alone sticks to the word before it, so no line starts with one
// and looks like a new speaker. Text without spaces (Chinese, Japanese,
// Thai) is left as it is.
function splitLine(text, maxChars = MAX_LINE_CHARS) {
    const words = [];
    for (const token of text.match(WORDS) || []) {
        if (/^[-\u2013\u2014]$/.test(token) && words.length) words[words.length - 1] += ` ${token}`;
        else words.push(token);
    }
    const total = visibleLength(words.join(' '));
    if (total <= maxChars || words.length < 2) return [words.join(' ')];

    const greedy = (width) => {
        const lines = [];
        let current = '';
        for (const word of words) {
            const candidate = current ? `${current} ${word}` : word;
            if (current && visibleLength(candidate) > width) {
                lines.push(current);
                current = word;
            } else {
                current = candidate;
            }
        }
        lines.push(current);
        return lines;
    };

    const twoLines = () => {
        let best = null;
        for (let i = 1; i < words.length; i++) {
            const top = words.slice(0, i).join(' ');
            const bottom = words.slice(i).join(' ');
            if (Math.max(visibleLength(top), visibleLength(bottom)) > maxChars) continue;
            if (isNumberLine(top) || isNumberLine(bottom)) continue;
            const afterPunctuation = /[,.;:!?\u060C\u061B\u061F]["'\u201D\u00BB)]*$/.test(top) && !ABBREVIATION.test(top);
            const score = Math.abs(visibleLength(top) - visibleLength(bottom)) - (afterPunctuation ? 8 : 0);
            if (!best || score < best.score) best = { lines: [top, bottom], score };
        }
        return best && best.lines;
    };

    // The narrowest width at which greedy filling needs only lineCount lines.
    const balanced = (lineCount) => {
        for (let width = Math.ceil(total / lineCount); width <= maxChars; width++) {
            const lines = greedy(width);
            if (lines.length <= lineCount && !lines.some(isNumberLine)) return lines;
        }
        return null;
    };

    for (let lineCount = Math.ceil(total / maxChars); lineCount <= words.length; lineCount++) {
        const lines = lineCount === 2 ? twoLines() : balanced(lineCount);
        if (lines) return lines;
    }
    return greedy(maxChars);
}

// Rewraps a block's lines when any of them is too long. Text over about 84
// characters needs three lines, since dropping words is not an option.
// Dialogue keeps one line per speaker: translation joins a block into one
// line, so a line that starts with a dash is split again where a new
// speaker's dash follows a finished sentence. Other lines are joined and
// rebalanced.
function wrapSubtitleLines(lines, maxChars = MAX_LINE_CHARS) {
    if (lines.every(line => visibleLength(line) <= maxChars)) return lines;
    if (lines.length > 1 && lines.every(line => LEADING_DASH.test(line))) {
        return lines.flatMap(line => wrapSubtitleLines([line], maxChars));
    }
    const joined = lines.join(' ');
    if (LEADING_DASH.test(joined)) {
        const speakers = joined.split(SPEAKER_BREAK);
        if (speakers.length > 1) return speakers.flatMap(line => splitLine(line, maxChars));
    }
    return splitLine(joined, maxChars);
}

// Applies wrapSubtitleLines to an SRT whose blocks are separated by one
// blank line. It splits on that instead of calling parseSRT, which would read
// a line of digits as a new block. Text starts after the line with "-->", so a
// missing or extra index line does not shift it, and a block without timing
// stays as it is. Arabic and Persian lines carry bidi marks per line, so those
// are stripped before wrapping and put back on every new line.
function wrapSRT(content, maxChars = MAX_LINE_CHARS) {
    return content.split(/\n\n+/).map(block => {
        const lines = block.split('\n');
        const timing = lines.findIndex(line => line.includes('-->'));
        if (timing === -1) return block;
        const head = lines.slice(0, timing + 1);
        const text = lines.slice(timing + 1);
        if (text.length === 0) return block;
        const isRTL = text.some(line => /[\u200F\u202B\u202C]/.test(line));
        const plain = isRTL ? text.map(line => line.replace(/[\u200F\u202B\u202C]/g, '')) : text;
        const wrapped = wrapSubtitleLines(plain, maxChars);
        if (wrapped === plain) return block;
        return [...head, ...(isRTL ? wrapped.map(formatRTLLine) : wrapped)].join('\n');
    }).join('\n\n');
}

if (typeof module === 'object' && module.exports) {
    module.exports = { MAX_LINE_CHARS, formatRTLLine, splitLine, wrapSubtitleLines, wrapSRT };
}
