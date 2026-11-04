import assert from 'node:assert/strict';
import test from 'node:test';

import {
    blocksToSRT,
    chatCompletionsUrl,
    createSmartChunks,
    formatTranslatedText,
    parseSRT,
    thinkingRequestFields
} from './translate-srt.mjs';

test('parses CRLF SRT files and preserves multiline subtitle text', () => {
    const blocks = parseSRT('1\r\n00:00:00,000 --> 00:00:01,000\r\nHello\r\nworld\r\n\r\n2\r\n00:00:02,000 --> 00:00:03,000\r\nBye');
    assert.deepEqual(blocks, [
        { index: 1, timestamp: '00:00:00,000 --> 00:00:01,000', text: ['Hello', 'world'] },
        { index: 2, timestamp: '00:00:02,000 --> 00:00:03,000', text: ['Bye'] }
    ]);
});

test('creates sentence-aware chunks without losing blocks', () => {
    const blocks = [1, 2, 3, 4].map((index) => ({
        index,
        timestamp: `${index} --> ${index + 1}`,
        text: [index === 2 ? 'A sentence.' : `Line ${index}`]
    }));
    const chunks = createSmartChunks(blocks, 2);
    assert.deepEqual(chunks.flat().map((block) => block.index), [1, 2, 3, 4]);
    assert.equal(chunks.length, 2);
});

test('serializes blocks back to SRT', () => {
    const blocks = parseSRT('1\n00:00:00,000 --> 00:00:01,000\nHello');
    assert.equal(blocksToSRT(blocks), '1\n00:00:00,000 --> 00:00:01,000\nHello');
});

test('formats RTL punctuation and direction markers', () => {
    const result = formatTranslatedText('مرحبا, كيف حالك؟', 'Arabic');
    assert.match(result, /^\u200F\u202B/);
    assert.match(result, /،/);
    assert.match(result, /؟/);
    assert.match(result, /\u202C$/);
});

test('builds the chat completions URL for a custom server', () => {
    assert.equal(chatCompletionsUrl('localhost:11434/v1'), 'http://localhost:11434/v1/chat/completions');
    assert.equal(chatCompletionsUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
    assert.equal(chatCompletionsUrl('https://api.example.com/v1/chat/completions?x=1'), 'https://api.example.com/v1/chat/completions?x=1');
    assert.equal(chatCompletionsUrl('api.example.com/v1'), null);
    assert.equal(chatCompletionsUrl('https://user:pass@api.example.com/v1'), null);
    assert.equal(chatCompletionsUrl('file:///etc/passwd'), null);
});

test('maps thinking levels to each provider\'s request fields', () => {
    assert.deepEqual(thinkingRequestFields('gemini', 'gemini-3.1-flash-lite', undefined), {});
    assert.deepEqual(thinkingRequestFields('openrouter', 'x', 'high'), { reasoning: { effort: 'high' } });
    assert.deepEqual(thinkingRequestFields('openai', 'x', 'low'), { reasoning_effort: 'low' });
    assert.deepEqual(thinkingRequestFields('gemini', 'gemini-3.1-flash-lite', 'medium'), { thinkingConfig: { thinkingLevel: 'medium' } });
    assert.deepEqual(thinkingRequestFields('gemini', 'gemini-2.5-flash', 'low'), { thinkingConfig: { thinkingBudget: 1024 } });
    assert.deepEqual(thinkingRequestFields('gemini', 'gemini-flash-latest', 'high'), { thinkingConfig: { thinkingBudget: 24576 } });
    assert.deepEqual(thinkingRequestFields('gemini', 'gemini-2.0-flash', 'low'), {});
    assert.deepEqual(thinkingRequestFields('gemini', 'gemma-3-27b-it', 'low'), {});
});
