// ============================================
// SRT Translator - App Logic
// ============================================

const DEFAULT_MODEL_GEMINI = 'gemini-3.1-flash-lite';
const DEFAULT_MODEL_OPENROUTER = 'google/gemini-3.1-flash-lite';
const DEFAULT_PARALLEL = 5; // Safe default for Gemini API Free Tier
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;  // 1 second
const REQUEST_TIMEOUT_MS = 30000;  // 30 seconds

// Custom API Error class to propagate status and detailed payload
class APIError extends Error {
    constructor(status, message, details) {
        super(message);
        this.status = status;
        this.details = details;
    }
}

// State
let srtContent = '';
let srtBlocks = [];
let translatedResult = '';
let originalFileName = '';

// DOM Elements
const elements = {
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    dropText: document.getElementById('dropText'),
    fileName: document.getElementById('fileName'),
    translateBtn: document.getElementById('translateBtn'),
    translateBtnText: document.getElementById('translateBtnText'),
    progressCard: document.getElementById('progressCard'),
    downloadBtn: document.getElementById('downloadBtn'),
    apiKey: document.getElementById('apiKey'),
    customModel: document.getElementById('customModel'),
    targetLanguage: document.getElementById('targetLanguage'),
    chunkSize: document.getElementById('chunkSize'),
    parallelRequests: document.getElementById('parallelRequests'),
    customInstructions: document.getElementById('customInstructions'),
    chunksGrid: document.getElementById('chunksGrid'),
    logContainer: document.getElementById('logContainer'),
    progressFill: document.getElementById('progressFill'),
    progressPercent: document.getElementById('progressPercent'),
    totalChunks: document.getElementById('totalChunks'),
    completedChunks: document.getElementById('completedChunks'),
    failedChunks: document.getElementById('failedChunks'),
    optimizeTimings: document.getElementById('optimizeTimings'),
    mergeSubtitles: document.getElementById('mergeSubtitles'),
    apiProvider: document.getElementById('apiProvider')
};

// ============================================
// Initialization
// ============================================

function init() {
    loadSavedSettings();
    updateProviderUI();
    setupEventListeners();
}

function updateProviderUI() {
    const provider = elements.apiProvider.value;
    if (provider === 'openrouter') {
        elements.apiKey.placeholder = 'Enter your OpenRouter API key...';
        elements.customModel.placeholder = `Custom model (leave empty for default: ${DEFAULT_MODEL_OPENROUTER})`;
    } else {
        elements.apiKey.placeholder = 'Enter your Gemini API key...';
        elements.customModel.placeholder = `Custom model (leave empty for default: ${DEFAULT_MODEL_GEMINI})`;
    }
}

function loadSavedSettings() {
    const savedProvider = localStorage.getItem('srt_api_provider');
    const savedApiKey = localStorage.getItem('srt_gemini_api_key') || localStorage.getItem('srt_openrouter_api_key');
    const savedModel = localStorage.getItem('srt_custom_model');
    const savedLanguage = localStorage.getItem('srt_target_language');
    const savedChunkSize = localStorage.getItem('srt_chunk_size');
    const savedParallel = localStorage.getItem('srt_parallel_requests');
    const savedInstructions = localStorage.getItem('srt_custom_instructions');
    const savedOptimize = localStorage.getItem('srt_optimize_timings');
    const savedMerge = localStorage.getItem('srt_merge_subtitles');

    if (savedProvider) elements.apiProvider.value = savedProvider;
    else elements.apiProvider.value = 'gemini';

    // Load saved API key (check provider-specific keys first)
    const provider = elements.apiProvider.value;
    const providerKey = localStorage.getItem(`srt_${provider}_api_key`);
    if (providerKey) {
        elements.apiKey.value = providerKey.trim();
    } else if (savedApiKey) {
        elements.apiKey.value = savedApiKey.trim();
    }

    if (savedModel) elements.customModel.value = savedModel.trim();
    if (savedLanguage) elements.targetLanguage.value = savedLanguage.trim();
    if (savedChunkSize) elements.chunkSize.value = savedChunkSize.trim();
    if (savedParallel) elements.parallelRequests.value = savedParallel.trim();
    else elements.parallelRequests.value = DEFAULT_PARALLEL;
    if (savedInstructions) elements.customInstructions.value = savedInstructions;
    
    if (savedOptimize !== null) elements.optimizeTimings.checked = savedOptimize === 'true';
    else elements.optimizeTimings.checked = false; // Default to false (disabled) to avoid messing up original timings

    if (savedMerge !== null) elements.mergeSubtitles.checked = savedMerge === 'true';
    else elements.mergeSubtitles.checked = false; // Default to false (disabled)
}

function saveSettings() {
    const provider = elements.apiProvider.value;
    localStorage.setItem('srt_api_provider', provider);
    localStorage.setItem(`srt_${provider}_api_key`, elements.apiKey.value.trim());
    localStorage.setItem('srt_custom_model', elements.customModel.value.trim());
    localStorage.setItem('srt_target_language', elements.targetLanguage.value);
    localStorage.setItem('srt_chunk_size', elements.chunkSize.value);
    localStorage.setItem('srt_parallel_requests', elements.parallelRequests.value);
    localStorage.setItem('srt_custom_instructions', elements.customInstructions.value);
    localStorage.setItem('srt_optimize_timings', elements.optimizeTimings.checked);
    localStorage.setItem('srt_merge_subtitles', elements.mergeSubtitles.checked);
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // File upload
    elements.dropZone.addEventListener('click', () => elements.fileInput.click());
    elements.dropZone.addEventListener('dragover', handleDragOver);
    elements.dropZone.addEventListener('dragleave', handleDragLeave);
    elements.dropZone.addEventListener('drop', handleDrop);
    elements.fileInput.addEventListener('change', handleFileSelect);

    // Settings changes
    elements.apiKey.addEventListener('input', () => {
        saveSettings();
        updateTranslateButton();
    });
    elements.apiProvider.addEventListener('change', () => {
        saveSettings();
        updateProviderUI();
        updateTranslateButton();
    });
    elements.customModel.addEventListener('change', saveSettings);
    elements.targetLanguage.addEventListener('change', () => {
        saveSettings();
        updateTranslateButtonText();
    });
    elements.chunkSize.addEventListener('change', saveSettings);
    elements.parallelRequests.addEventListener('change', saveSettings);
    elements.customInstructions.addEventListener('change', saveSettings);
    elements.optimizeTimings.addEventListener('change', () => {
        saveSettings();
        reprocessLoadedFile();
    });
    elements.mergeSubtitles.addEventListener('change', () => {
        saveSettings();
        reprocessLoadedFile();
    });

    // Actions
    elements.translateBtn.addEventListener('click', startTranslation);
    elements.downloadBtn.addEventListener('click', downloadResult);

    // Initial UI state
    updateTranslateButton();
    updateTranslateButtonText();
}

function handleDragOver(e) {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
}

function handleDragLeave() {
    elements.dropZone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    const file = e.dataTransfer.files[0];
    if (file && file.name.endsWith('.srt')) {
        processFile(file);
    }
}

function handleFileSelect(e) {
    const file = e.target.files[0];
    if (file) processFile(file);
}

// ============================================
// File Processing
// ============================================

function reprocessLoadedFile() {
    if (srtContent) {
        srtBlocks = parseSRT(srtContent);
        if (elements.mergeSubtitles.checked) {
            mergeShortSubtitles(srtBlocks);
        }
        if (elements.optimizeTimings.checked) {
            optimizeTimings(srtBlocks);
        }
        elements.dropText.textContent = `Loaded: ${srtBlocks.length} subtitle blocks`;
    }
}

function processFile(file) {
    originalFileName = file.name;
    const reader = new FileReader();

    reader.onload = (e) => {
        srtContent = e.target.result;
        reprocessLoadedFile();

        elements.fileName.textContent = file.name;
        elements.fileName.classList.remove('hidden');

        updateTranslateButton();
    };

    reader.readAsText(file);
}

function parseSRT(content) {
    const blocks = [];
    const lines = content.split('\n');
    let currentBlock = null;

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();

        if (/^\d+$/.test(line)) {
            if (currentBlock) {
                blocks.push(currentBlock);
            }
            currentBlock = {
                index: parseInt(line),
                timestamp: '',
                text: []
            };
        } else if (currentBlock && line.includes('-->')) {
            currentBlock.timestamp = line;
        } else if (currentBlock && line !== '') {
            currentBlock.text.push(line);
        }
    }

    if (currentBlock) {
        blocks.push(currentBlock);
    }

    return blocks;
}

// ============================================
// Smart Chunking
// ============================================

function createSmartChunks(blocks, targetSize) {
    const chunks = [];
    let currentChunk = [];

    for (let i = 0; i < blocks.length; i++) {
        currentChunk.push(blocks[i]);

        if (currentChunk.length >= targetSize) {
            let splitIndex = -1;

            // Look for sentence ending in last 10 blocks
            for (let j = currentChunk.length - 1; j >= Math.max(0, currentChunk.length - 10); j--) {
                const text = currentChunk[j].text.join(' ');
                if (/[.!?][\s"']*$/.test(text)) {
                    splitIndex = j;
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
    }

    if (currentChunk.length > 0) {
        chunks.push(currentChunk);
    }

    return chunks;
}

function blocksToSRT(blocks) {
    return blocks.map(block => {
        return `${block.index}\n${block.timestamp}\n${block.text.join('\n')}`;
    }).join('\n\n');
}

// ============================================
// UI Updates
// ============================================

function updateTranslateButton() {
    elements.translateBtn.disabled = !srtContent || !elements.apiKey.value.trim();
}

function updateTranslateButtonText() {
    const lang = elements.targetLanguage.value;
    elements.translateBtnText.textContent = `Translate to ${lang}`;
}

function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    entry.innerHTML = `<span class="log-time">${time}</span><span class="log-${type}">${message}</span>`;
    elements.logContainer.insertBefore(entry, elements.logContainer.firstChild);
}

function updateProgress(completed, failed, total) {
    elements.completedChunks.textContent = completed;
    elements.failedChunks.textContent = failed;

    const percent = Math.round((completed + failed) / total * 100);
    elements.progressPercent.textContent = `${percent}%`;
    elements.progressFill.style.width = `${percent}%`;
}

function setChunkStatus(index, status) {
    const indicator = document.querySelector(`[data-chunk="${index}"]`);
    if (indicator) {
        indicator.className = `chunk-indicator ${status}`;
    }
}

// ============================================
// Translation API
// ============================================

function buildSystemPrompt(targetLanguage, customInstructions) {
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

⚠️ IMPORTANT FOR RIGHT-TO-LEFT TRANSLATION:
- You MUST use correct RTL punctuation (e.g. use Arabic/Persian comma '،' instead of English ',', and Arabic/Persian question mark '؟' instead of English '?').
- Do NOT translate English names, technical terms, or code if they are best kept in English, but ensure they are embedded naturally in the RTL structure.`;
    }

    if (customInstructions && customInstructions.trim()) {
        prompt += `\n\n⚠️ MANDATORY USER INSTRUCTIONS (MUST FOLLOW):\n${customInstructions.trim()}\n\nYou MUST follow these instructions exactly. They override any conflicting rules.`;
    }

    return prompt;
}

// Extract text with block markers - one per line
function extractTextWithMarkers(blocks) {
    return blocks.map((block, i) => `[B${i + 1}] ${block.text.join(' ')}`).join('\n');
}

// Parse translated text with markers back into blocks
function parseMarkedTranslation(blocks, translatedText) {
    const result = [];

    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const markerStart = `[B${i + 1}]`;
        const markerEnd = `[B${i + 2}]`;

        const startIdx = translatedText.indexOf(markerStart);
        if (startIdx === -1) {
            // Marker not found, use original
            result.push({
                index: block.index,
                timestamp: block.timestamp,
                text: [block.text.join(' ')]
            });
            continue;
        }

        const textStart = startIdx + markerStart.length;
        let textEnd;

        if (i === blocks.length - 1) {
            textEnd = translatedText.length;
        } else {
            const endIdx = translatedText.indexOf(markerEnd);
            textEnd = endIdx !== -1 ? endIdx : translatedText.length;
        }

        const blockText = translatedText.substring(textStart, textEnd).trim();

        result.push({
            index: block.index,
            timestamp: block.timestamp,
            text: [blockText]
        });
    }

    return result;
}

async function translateChunk(chunk, index, apiKey, model, targetLanguage, customInstructions, provider) {
    // Extract text with block markers
    const markedText = extractTextWithMarkers(chunk);
    const systemPrompt = buildSystemPrompt(targetLanguage, customInstructions);

    console.log(`[Chunk ${index + 1}] Sending API request...`);

    // Create abort controller for timeout
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`[Chunk ${index + 1}] TIMEOUT - aborting request`);
        controller.abort();
    }, REQUEST_TIMEOUT_MS);

    try {
        let response;
        if (provider === 'openrouter') {
            response = await fetch('https://openrouter.ai/api/v1/chat/completions', {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${apiKey.trim()}`,
                    'HTTP-Referer': window.location.origin && window.location.origin !== 'null' ? window.location.origin : 'https://github.com/AmiraliNotFound/better-ai-srt-translation',
                    'X-Title': 'Better AI SRT Translation'
                },
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: markedText }
                    ],
                    temperature: 0.3
                }),
                signal: controller.signal
            });
        } else {
            response = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey.trim()}`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    contents: [
                        {
                            role: 'user',
                            parts: [
                                { text: markedText }
                            ]
                        }
                    ],
                    systemInstruction: {
                        parts: [
                            { text: systemPrompt }
                        ]
                    },
                    generationConfig: {
                        temperature: 0.3
                    }
                }),
                signal: controller.signal
            });
        }

        console.log(`[Chunk ${index + 1}] Response received, status: ${response.status}`);
        clearTimeout(timeoutId);

        if (!response.ok) {
            const errorText = await response.text();
            let details = null;
            let message = errorText;
            try {
                const errorObj = JSON.parse(errorText);
                if (errorObj.error) {
                    message = errorObj.error.message || errorText;
                    details = errorObj.error.details || null;
                }
            } catch (e) {
                // not JSON
            }
            throw new APIError(response.status, message, details);
        }

        const data = await response.json();
        console.log(`[Chunk ${index + 1}] Parsed response, parsing markers...`);

        let translatedText;
        if (provider === 'openrouter') {
            if (!data.choices || data.choices.length === 0 || !data.choices[0].message || !data.choices[0].message.content) {
                throw new Error('Invalid or empty response structure from OpenRouter');
            }
            translatedText = data.choices[0].message.content;
        } else {
            if (!data.candidates || data.candidates.length === 0 || !data.candidates[0].content || !data.candidates[0].content.parts || data.candidates[0].content.parts.length === 0) {
                throw new Error('Invalid or empty response structure from Gemini API');
            }
            translatedText = data.candidates[0].content.parts[0].text;
        }

        // Parse markers and map back to blocks
        const translatedBlocks = parseMarkedTranslation(chunk, translatedText);

        // Convert back to SRT format and handle RTL formatting if target language is RTL (Arabic, Persian)
        const isRTL = ['Arabic', 'Persian'].includes(targetLanguage);
        return translatedBlocks.map(block => {
            let text = block.text.join('\n');
            if (isRTL) {
                const rlm = '\u200F';
                const rle = '\u202B';
                const pdf = '\u202C';

                // Replace English commas not between digits with Arabic/Persian comma
                text = text.replace(/(?<!\d),|,(?!\d)/g, '،');
                // Replace English question mark with Arabic/Persian question mark
                text = text.replace(/\?/g, '؟');
                // Replace English semicolon with Arabic/Persian semicolon
                text = text.replace(/;/g, '؛');

                text = text.split('\n').map(line => {
                    const trimmed = line.trim();
                    if (trimmed === '') return line;
                    
                    let formattedLine = line;
                    // Wrap line in RLE/PDF and prepend RLM
                    if (!formattedLine.startsWith(rle)) {
                        formattedLine = rle + formattedLine;
                    }
                    if (!formattedLine.endsWith(pdf)) {
                        formattedLine = formattedLine + pdf;
                    }
                    if (!formattedLine.startsWith(rlm)) {
                        formattedLine = rlm + formattedLine;
                    }
                    return formattedLine;
                }).join('\n');
            }
            return `${block.index}\n${block.timestamp}\n${text}`;
        }).join('\n\n');

    } catch (error) {
        clearTimeout(timeoutId);
        console.log(`[Chunk ${index + 1}] Error:`, error.name, error.message);
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
        }
        throw error;
    }
}

// Retry wrapper with exponential backoff, and smart rate-limit (429) delay handling
async function translateChunkWithRetry(chunk, index, apiKey, model, targetLanguage, customInstructions, provider, onRetry) {
    let lastError;
    let maxAttempts = MAX_RETRIES;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await translateChunk(chunk, index, apiKey, model, targetLanguage, customInstructions, provider);
        } catch (error) {
            lastError = error;

            if (attempt < maxAttempts) {
                let delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff

                // Smart handling of 429 Rate Limits
                if (error.status === 429) {
                    // Increase max attempts for rate limit retries to give it more chances
                    maxAttempts = Math.max(maxAttempts, 8);
                    
                    let retrySeconds = 60; // Default fallback wait is 60 seconds
                    
                    // Try to parse retryDelay from Google API error details
                    if (error.details && Array.isArray(error.details)) {
                        const retryInfo = error.details.find(d => d['@type'] === 'type.googleapis.com/google.rpc.RetryInfo');
                        if (retryInfo && retryInfo.retryDelay) {
                            // Format: "50s" or "50.93s"
                            const secondsMatch = retryInfo.retryDelay.match(/^([\d.]+)\s*s$/i);
                            if (secondsMatch) {
                                retrySeconds = parseFloat(secondsMatch[1]);
                            }
                        }
                    }
                    
                    // Add a small safety buffer (2 seconds)
                    delay = (retrySeconds + 2) * 1000;
                }

                onRetry(index, attempt, delay, error.message);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    }

    throw lastError;
}

// ============================================
// Main Translation Flow
// ============================================

async function startTranslation() {
    const apiKey = elements.apiKey.value.trim();
    if (!apiKey || !srtContent) return;

    // Get settings
    const provider = elements.apiProvider.value;
    const defaultModel = provider === 'openrouter' ? DEFAULT_MODEL_OPENROUTER : DEFAULT_MODEL_GEMINI;
    const model = elements.customModel.value.trim() || defaultModel;
    const targetLanguage = elements.targetLanguage.value;
    const targetChunkSize = parseInt(elements.chunkSize.value) || 50;
    const maxParallel = parseInt(elements.parallelRequests.value) || DEFAULT_PARALLEL;
    const customInstructions = elements.customInstructions.value;

    // Create chunks
    const chunks = createSmartChunks(srtBlocks, targetChunkSize);

    // Setup UI
    elements.progressCard.classList.remove('hidden');
    elements.downloadBtn.classList.add('hidden');
    elements.translateBtn.disabled = true;
    elements.logContainer.innerHTML = '';

    elements.totalChunks.textContent = chunks.length;

    // Create chunk indicators
    elements.chunksGrid.innerHTML = '';
    chunks.forEach((_, i) => {
        const indicator = document.createElement('div');
        indicator.className = 'chunk-indicator pending';
        indicator.dataset.chunk = i;
        indicator.textContent = i + 1;
        elements.chunksGrid.appendChild(indicator);
    });

    log(`Starting translation to ${targetLanguage}...`, 'info');
    log(`Model: ${model}`, 'info');
    log(`Chunks: ${chunks.length} | Size: ~${targetChunkSize} | Parallel: ${maxParallel}`, 'info');

    let completed = 0;
    let failed = 0;
    const results = new Array(chunks.length).fill(null);

    // Process a single chunk
    async function processChunk(chunk, index) {
        setChunkStatus(index, 'processing');
        const blockCount = chunk.length;
        const textLength = chunk.reduce((sum, b) => sum + b.text.join(' ').length, 0);

        try {
            log(`Chunk ${index + 1} starting (${blockCount} blocks, ${textLength} chars)...`, 'info');

            const translated = await translateChunkWithRetry(
                chunk,
                index,
                apiKey,
                model,
                targetLanguage,
                customInstructions,
                provider,
                (idx, attempt, delay, errorMsg) => {
                    setChunkStatus(idx, 'error');
                    const waitSec = Math.round(delay / 1000);
                    log(`Chunk ${idx + 1} rate limited/failed. Retrying (attempt ${attempt}) in ${waitSec}s...`, 'error');
                    setTimeout(() => setChunkStatus(idx, 'processing'), 100);
                }
            );

            results[index] = translated;
            completed++;
            setChunkStatus(index, 'done');
            log(`Chunk ${index + 1} completed`, 'success');
        } catch (error) {
            failed++;
            setChunkStatus(index, 'error');
            log(`Chunk ${index + 1} FAILED: ${error.message}`, 'error');
            results[index] = blocksToSRT(chunk);
        }

        updateProgress(completed, failed, chunks.length);
    }

    // Process all chunks with controlled concurrency
    const processing = new Set();
    let nextIndex = 0;

    async function processNext() {
        while (nextIndex < chunks.length) {
            const index = nextIndex++;
            const chunk = chunks[index];

            const promise = processChunk(chunk, index).finally(() => {
                processing.delete(promise);
            });
            processing.add(promise);

            // If at max concurrency, wait for one to complete
            if (processing.size >= maxParallel) {
                await Promise.race(processing);
            }
        }
        // Wait for remaining
        await Promise.all(processing);
    }

    await processNext();

    // Merge results
    translatedResult = results.join('\n\n');

    const status = completed === chunks.length ? 'success' : 'error';
    log(`Translation complete! ${completed} successful, ${failed} failed`, status);

    elements.translateBtn.disabled = false;
    elements.downloadBtn.classList.remove('hidden');
}

// ============================================
// Download
// ============================================

function downloadResult() {
    const lang = elements.targetLanguage.value;
    const langCode = getLanguageCode(lang);

    const blob = new Blob([translatedResult], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = originalFileName.replace('.srt', `_${langCode}.srt`);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);

    log(`Downloaded: ${a.download}`, 'success');
}

function getLanguageCode(language) {
    const codes = {
        'Turkish': 'TR',
        'English': 'EN',
        'Spanish': 'ES',
        'French': 'FR',
        'German': 'DE',
        'Italian': 'IT',
        'Portuguese': 'PT',
        'Russian': 'RU',
        'Japanese': 'JA',
        'Korean': 'KO',
        'Chinese (Simplified)': 'ZH-CN',
        'Chinese (Traditional)': 'ZH-TW',
        'Arabic': 'AR',
        'Persian': 'FA',
        'Hindi': 'HI',
        'Dutch': 'NL',
        'Polish': 'PL',
        'Swedish': 'SV',
        'Vietnamese': 'VI',
        'Thai': 'TH',
        'Indonesian': 'ID',
        'Greek': 'EL'
    };
    return codes[language] || 'TRANSLATED';
}

// Timing optimization to extend short "flash-and-go" subtitles (minimum 1.3 seconds)
function optimizeTimings(blocks, minDurationMs = 1300) {
    for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const times = parseTimestampRange(block.timestamp);
        if (!times) continue;
        
        const duration = times.end - times.start;
        if (duration < minDurationMs) {
            let nextStart = Infinity;
            if (i < blocks.length - 1) {
                const nextTimes = parseTimestampRange(blocks[i + 1].timestamp);
                if (nextTimes) {
                    nextStart = nextTimes.start;
                }
            }
            
            // Extend duration up to minDurationMs, leaving a 50ms gap before the next subtitle starts
            const extendedEnd = times.start + minDurationMs;
            const maxAllowedEnd = nextStart - 50;
            const newEnd = Math.max(times.end, Math.min(extendedEnd, maxAllowedEnd));
            
            if (newEnd > times.end) {
                block.timestamp = `${formatMs(times.start)} --> ${formatMs(newEnd)}`;
            }
        }
    }
}

// Merge short trailing subtitle blocks into the previous block if they are part of the same sentence
function mergeShortSubtitles(blocks, maxCombinedWords = 15, maxCombinedChars = 80, shortBlockDurationMs = 1200, shortWordCount = 4) {
    let i = 0;
    while (i < blocks.length - 1) {
        const currentBlock = blocks[i];
        const nextBlock = blocks[i + 1];
        
        const currentTimes = parseTimestampRange(currentBlock.timestamp);
        const nextTimes = parseTimestampRange(nextBlock.timestamp);
        
        if (!currentTimes || !nextTimes) {
            i++;
            continue;
        }
        
        const nextDuration = nextTimes.end - nextTimes.start;
        const nextTextJoined = nextBlock.text.join(' ');
        const nextWords = nextTextJoined.split(/\s+/).filter(Boolean);
        
        // Next block is candidates for merging if it has short duration or very few words
        const isNextShort = nextDuration < shortBlockDurationMs || nextWords.length <= shortWordCount;
        
        const currentTextJoined = currentBlock.text.join(' ');
        const endsWithPunctuation = /[.!?]['"]*$/.test(currentTextJoined.trim());
        const startsWithCapital = /^[A-Z]/.test(nextTextJoined.trim());
        const isContinuingSentence = !endsWithPunctuation && !startsWithCapital;
        
        if (isNextShort && isContinuingSentence) {
            const combinedText = currentBlock.text.concat(nextBlock.text);
            const combinedTextJoined = combinedText.join(' ');
            const combinedWords = combinedTextJoined.split(/\s+/).filter(Boolean);
            
            // Check if combined block length is within limits to avoid "filling the page"
            if (combinedWords.length <= maxCombinedWords && combinedTextJoined.length <= maxCombinedChars) {
                // Merge nextBlock into currentBlock (join text into a single line)
                const joinedText = currentBlock.text.join(' ') + ' ' + nextBlock.text.join(' ');
                currentBlock.text = [joinedText];
                currentBlock.timestamp = `${formatMs(currentTimes.start)} --> ${formatMs(nextTimes.end)}`;
                
                // Remove nextBlock from array
                blocks.splice(i + 1, 1);
                
                // Do not increment i, so we can check if this new combined block can merge with the next one
                continue;
            }
        }
        
        i++;
    }
    
    // Re-index all blocks
    for (let idx = 0; idx < blocks.length; idx++) {
        blocks[idx].index = idx + 1;
    }
}

function parseTimestampRange(timestampStr) {
    if (!timestampStr) return null;
    const parts = timestampStr.split('-->');
    if (parts.length !== 2) return null;
    
    function parseTime(t) {
        const clean = t.trim().replace('.', ',');
        const subparts = clean.split(',');
        if (subparts.length !== 2) return 0;
        
        const hms = subparts[0].split(':');
        if (hms.length !== 3) return 0;
        
        const h = parseInt(hms[0]) || 0;
        const m = parseInt(hms[1]) || 0;
        const s = parseInt(hms[2]) || 0;
        const ms = parseInt(subparts[1]) || 0;
        
        return (h * 3600 + m * 60 + s) * 1000 + ms;
    }
    
    return {
        start: parseTime(parts[0]),
        end: parseTime(parts[1])
    };
}

function formatMs(ms) {
    const hours = Math.floor(ms / 3600000);
    const minutes = Math.floor((ms % 3600000) / 60000);
    const seconds = Math.floor((ms % 60000) / 1000);
    const msec = ms % 1000;
    
    const pad = (num, size) => num.toString().padStart(size, '0');
    return `${pad(hours, 2)}:${pad(minutes, 2)}:${pad(seconds, 2)},${pad(msec, 3)}`;
}

// ============================================
// Initialize App
// ============================================

init();
