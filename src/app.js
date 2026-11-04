// ============================================
// SRT Translator - App Logic
// ============================================

const DEFAULT_MODEL_GEMINI = 'gemini-3.1-flash-lite';
const DEFAULT_MODEL_OPENROUTER = 'google/gemini-3.1-flash-lite';
const PROVIDERS = ['gemini', 'openrouter', 'openai'];
// Providers that speak the OpenAI chat completions format.
const OPENAI_STYLE_PROVIDERS = ['openrouter', 'openai'];
const DEFAULT_PARALLEL = 5; // Safe default for Gemini API Free Tier
const MAX_RETRIES = 3;
const RETRY_DELAY_MS = 1000;  // 1 second
const REQUEST_TIMEOUT_MS = 30000;  // 30 seconds
// Self-hosted servers often run one request at a time, so queued chunks wait longer.
const CUSTOM_SERVER_TIMEOUT_MS = 120000;  // 2 minutes
const RLM = '\u200F';
const RLE = '\u202B';
const PDF = '\u202C';
// Netflix and BBC style guides cap a subtitle line at about 42 characters.
const MAX_LINE_CHARS = 42;
const SETTINGS_FILE_FORMAT = 'better-ai-srt-translation-settings';
const SETTINGS_FILE_VERSION = 1;
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;
const THINKING_LEVELS = ['low', 'medium', 'high'];
// Gemini 2.5 takes a token budget instead of a level.
const GEMINI_THINKING_BUDGETS = { low: 1024, medium: 8192, high: 24576 };
const MODEL_LIST_TIMEOUT_MS = 15000;

// Custom API Error class to propagate status and detailed payload
class APIError extends Error {
    constructor(status, message, details, retryAfterSeconds = null) {
        super(message);
        this.status = status;
        this.details = details;
        this.retryAfterSeconds = retryAfterSeconds;
    }
}

// State
let srtContent = '';
let srtBlocks = [];
let translatedResult = '';
let originalFileName = '';
let isTranslating = false;
let dropdowns = [];
let settingsStatusTimer = null;
let modelCombobox = null;
// Model lists that loaded, keyed by provider, URL and key.
const modelListCache = new Map();
let modelListKey = '';
// Bumped on every load and reset, so only the newest request may update the list.
let modelListRequest = 0;

// DOM Elements
const elements = {
    dropZone: document.getElementById('dropZone'),
    fileInput: document.getElementById('fileInput'),
    dropText: document.getElementById('dropText'),
    filePreview: document.getElementById('filePreview'),
    fileName: document.getElementById('fileName'),
    translateBtn: document.getElementById('translateBtn'),
    translateBtnText: document.getElementById('translateBtnText'),
    progressCard: document.getElementById('progressCard'),
    downloadBtn: document.getElementById('downloadBtn'),
    apiKey: document.getElementById('apiKey'),
    customModel: document.getElementById('customModel'),
    thinkingLevel: document.getElementById('thinkingLevel'),
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
    wrapLines: document.getElementById('wrapLines'),
    apiProvider: document.getElementById('apiProvider'),
    apiBaseUrl: document.getElementById('apiBaseUrl'),
    baseUrlField: document.getElementById('baseUrlField'),
    exportSettingsBtn: document.getElementById('exportSettingsBtn'),
    importSettingsBtn: document.getElementById('importSettingsBtn'),
    settingsFileInput: document.getElementById('settingsFileInput'),
    settingsFileStatus: document.getElementById('settingsFileStatus')
};

// ============================================
// Initialization
// ============================================

function init() {
    loadSavedSettings();
    dropdowns = [enhanceSelect(elements.apiProvider), enhanceSelect(elements.thinkingLevel), enhanceSelect(elements.targetLanguage)];
    modelCombobox = enhanceCombobox(elements.customModel, { onOpen: loadModelList });
    updateProviderUI();
    setupEventListeners();
}

function updateProviderUI() {
    const provider = elements.apiProvider.value;
    elements.baseUrlField.classList.toggle('hidden', provider !== 'openai');
    if (provider === 'openai') {
        elements.apiKey.placeholder = 'Optional for servers without auth';
        elements.customModel.placeholder = 'Required, e.g. gpt-4.1-mini or llama3.1';
    } else if (provider === 'openrouter') {
        elements.apiKey.placeholder = 'Paste your OpenRouter API key';
        elements.customModel.placeholder = `Default: ${DEFAULT_MODEL_OPENROUTER}`;
    } else {
        elements.apiKey.placeholder = 'Paste your Gemini API key';
        elements.customModel.placeholder = `Default: ${DEFAULT_MODEL_GEMINI}`;
    }
}

function loadSavedSettings() {
    const savedProvider = localStorage.getItem('srt_api_provider');
    const savedLanguage = localStorage.getItem('srt_target_language');
    const savedChunkSize = localStorage.getItem('srt_chunk_size');
    const savedParallel = localStorage.getItem('srt_parallel_requests');
    const savedInstructions = localStorage.getItem('srt_custom_instructions');
    const savedOptimize = localStorage.getItem('srt_optimize_timings');
    const savedMerge = localStorage.getItem('srt_merge_subtitles');
    const savedWrap = localStorage.getItem('srt_wrap_lines');
    const savedThinking = localStorage.getItem('srt_thinking_level');

    elements.apiProvider.value = PROVIDERS.includes(savedProvider) ? savedProvider : 'gemini';

    // Older versions kept one shared model field. Hand it to the provider that
    // was active then, the only one whose ID format it is known to match.
    const legacyModel = localStorage.getItem('srt_custom_model');
    if (legacyModel !== null) {
        const modelKey = `srt_${elements.apiProvider.value}_model`;
        if (localStorage.getItem(modelKey) === null) localStorage.setItem(modelKey, legacyModel);
        localStorage.removeItem('srt_custom_model');
    }

    loadProviderSettings();
    elements.apiBaseUrl.value = (localStorage.getItem('srt_openai_base_url') || '').trim();

    elements.thinkingLevel.value = THINKING_LEVELS.includes(savedThinking) ? savedThinking : '';
    if (savedLanguage) elements.targetLanguage.value = savedLanguage.trim();
    if (savedChunkSize) elements.chunkSize.value = savedChunkSize.trim();
    if (savedParallel) elements.parallelRequests.value = savedParallel.trim();
    else elements.parallelRequests.value = DEFAULT_PARALLEL;
    elements.customInstructions.value = savedInstructions || '';
    
    if (savedOptimize !== null) elements.optimizeTimings.checked = savedOptimize === 'true';
    else elements.optimizeTimings.checked = false; // Default to false (disabled) to avoid messing up original timings

    if (savedMerge !== null) elements.mergeSubtitles.checked = savedMerge === 'true';
    else elements.mergeSubtitles.checked = false; // Default to false (disabled)

    elements.wrapLines.checked = savedWrap === 'true';
}

// Key and model are stored per provider, so switching never carries one
// provider's key over to another provider's endpoint.
function loadProviderSettings() {
    const provider = elements.apiProvider.value;
    const keyName = `srt_${provider}_api_key`;
    let key = (localStorage.getItem(keyName) || '').trim();
    // Older versions could save one provider's key under another's name when
    // switching. Drop keys whose known prefix belongs to the other service.
    if ((provider === 'gemini' && key.startsWith('sk-or-')) || (provider === 'openrouter' && key.startsWith('AIza'))) {
        localStorage.removeItem(keyName);
        key = '';
    }
    elements.apiKey.value = key;
    elements.customModel.value = (localStorage.getItem(`srt_${provider}_model`) || '').trim();
}

function saveSettings() {
    const provider = elements.apiProvider.value;
    localStorage.setItem('srt_api_provider', provider);
    localStorage.setItem(`srt_${provider}_api_key`, elements.apiKey.value.trim());
    localStorage.setItem(`srt_${provider}_model`, elements.customModel.value.trim());
    localStorage.setItem('srt_openai_base_url', elements.apiBaseUrl.value.trim());
    localStorage.setItem('srt_thinking_level', elements.thinkingLevel.value);
    localStorage.setItem('srt_target_language', elements.targetLanguage.value);
    localStorage.setItem('srt_chunk_size', elements.chunkSize.value);
    localStorage.setItem('srt_parallel_requests', elements.parallelRequests.value);
    localStorage.setItem('srt_custom_instructions', elements.customInstructions.value);
    localStorage.setItem('srt_optimize_timings', elements.optimizeTimings.checked);
    localStorage.setItem('srt_merge_subtitles', elements.mergeSubtitles.checked);
    localStorage.setItem('srt_wrap_lines', elements.wrapLines.checked);
}

// ============================================
// Settings File (export / import)
// ============================================

function exportSettings() {
    saveSettings();
    const stored = (name) => (localStorage.getItem(name) || '').trim();
    const providers = {};
    for (const provider of PROVIDERS) {
        providers[provider] = { apiKey: stored(`srt_${provider}_api_key`), model: stored(`srt_${provider}_model`) };
    }
    providers.openai.baseUrl = stored('srt_openai_base_url');

    const settings = {
        format: SETTINGS_FILE_FORMAT,
        version: SETTINGS_FILE_VERSION,
        provider: elements.apiProvider.value,
        providers,
        thinkingLevel: elements.thinkingLevel.value,
        targetLanguage: elements.targetLanguage.value,
        // An emptied field exports as null, which import skips instead of clamping to the minimum.
        chunkSize: elements.chunkSize.value === '' ? null : Number(elements.chunkSize.value),
        parallelRequests: elements.parallelRequests.value === '' ? null : Number(elements.parallelRequests.value),
        customInstructions: elements.customInstructions.value,
        mergeSubtitles: elements.mergeSubtitles.checked,
        optimizeTimings: elements.optimizeTimings.checked,
        wrapLines: elements.wrapLines.checked
    };

    const blob = new Blob([JSON.stringify(settings, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.href = url;
    link.download = 'srt-translator-settings.json';
    link.click();
    // Some browsers start the download asynchronously; revoke a little later.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    showSettingsStatus('Settings exported. The file contains your API keys.');
}

// Returns a whole number within the input's min/max, or null if the value is not a number.
function clampToInput(value, input) {
    const number = Math.round(Number(value));
    if (value === null || value === '' || !Number.isFinite(number)) return null;
    return Math.min(Number(input.max), Math.max(Number(input.min), number));
}

// Writes an imported settings object to localStorage. Keys, models and the
// base URL are replaced as a set: a provider the file has no key for loses its
// saved key, so an old key never travels to a base URL that came from the file.
// Language, chunk size and parallel requests change only when the file has a
// valid value; otherwise the current one stays.
function applySettingsFile(data) {
    if (!data || typeof data !== 'object' || data.format !== SETTINGS_FILE_FORMAT) {
        throw new Error('This is not a settings file exported from this app.');
    }
    if (data.version !== SETTINGS_FILE_VERSION) {
        throw new Error('This settings file was made by a different version of the app.');
    }
    if (!PROVIDERS.includes(data.provider)) {
        throw new Error('The settings file names an unknown provider.');
    }
    const text = (value) => (typeof value === 'string' ? value.trim() : '');
    const providers = data.providers && typeof data.providers === 'object' ? data.providers : {};

    localStorage.setItem('srt_api_provider', data.provider);
    for (const provider of PROVIDERS) {
        const entry = providers[provider] && typeof providers[provider] === 'object' ? providers[provider] : {};
        localStorage.setItem(`srt_${provider}_api_key`, text(entry.apiKey));
        localStorage.setItem(`srt_${provider}_model`, text(entry.model));
    }
    localStorage.setItem('srt_openai_base_url', text(providers.openai && providers.openai.baseUrl));

    // Files from before the setting existed leave the current level alone.
    if (data.thinkingLevel === '' || THINKING_LEVELS.includes(data.thinkingLevel)) {
        localStorage.setItem('srt_thinking_level', data.thinkingLevel);
    }
    const language = text(data.targetLanguage);
    if (Array.from(elements.targetLanguage.options).some(option => option.value === language)) {
        localStorage.setItem('srt_target_language', language);
    }
    const chunkSize = clampToInput(data.chunkSize, elements.chunkSize);
    if (chunkSize !== null) localStorage.setItem('srt_chunk_size', String(chunkSize));
    const parallel = clampToInput(data.parallelRequests, elements.parallelRequests);
    if (parallel !== null) localStorage.setItem('srt_parallel_requests', String(parallel));
    localStorage.setItem('srt_custom_instructions', typeof data.customInstructions === 'string' ? data.customInstructions : '');
    localStorage.setItem('srt_merge_subtitles', String(data.mergeSubtitles === true));
    localStorage.setItem('srt_optimize_timings', String(data.optimizeTimings === true));
    localStorage.setItem('srt_wrap_lines', String(data.wrapLines === true));
}

async function importSettings(file) {
    if (!file) return;
    try {
        if (isTranslating) throw new Error('Wait for the translation to finish first.');
        if (file.size > SETTINGS_FILE_MAX_BYTES) throw new Error('This file is too large to be a settings file.');
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (e) {
            throw new Error('This file is not valid JSON.');
        }
        applySettingsFile(data);

        loadSavedSettings();
        dropdowns.forEach(dropdown => dropdown.sync());
        updateProviderUI();
        resetModelList();
        reprocessLoadedFile();
        updateTranslateButton();
        updateTranslateButtonText();
        // A shared file could point the custom provider at someone else's
        // server, so say where requests will now go.
        const endpoint = elements.apiProvider.value === 'openai' ? chatCompletionsUrl(elements.apiBaseUrl.value) : null;
        showSettingsStatus(endpoint ? `Settings imported. Requests will go to ${new URL(endpoint).host}.` : 'Settings imported.');
    } catch (error) {
        showSettingsStatus(`Could not import settings: ${error.message}`, true);
    } finally {
        // Allow importing the same file again after fixing it.
        elements.settingsFileInput.value = '';
    }
}

function showSettingsStatus(message, isError = false) {
    clearTimeout(settingsStatusTimer);
    const status = elements.settingsFileStatus;
    status.textContent = message;
    status.classList.toggle('error', isError);
    // Success notes clear after a while; errors stay until the next action.
    // The element is never display:none, so screen readers announce updates.
    if (!isError) settingsStatusTimer = setTimeout(() => { status.textContent = ''; }, 6000);
}

// ============================================
// Event Listeners
// ============================================

function setupEventListeners() {
    // File upload
    elements.dropZone.addEventListener('click', () => elements.fileInput.click());
    elements.dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            elements.fileInput.click();
        }
    });
    elements.dropZone.addEventListener('dragover', handleDragOver);
    elements.dropZone.addEventListener('dragleave', handleDragLeave);
    elements.dropZone.addEventListener('drop', handleDrop);
    elements.fileInput.addEventListener('change', handleFileSelect);

    // Settings changes
    elements.apiKey.addEventListener('input', () => {
        saveSettings();
        updateTranslateButton();
        resetModelList();
    });
    elements.apiProvider.addEventListener('change', () => {
        // Key and model fields already saved themselves under the previous
        // provider on input; load the new provider's values before saving.
        loadProviderSettings();
        saveSettings();
        updateProviderUI();
        updateTranslateButton();
        resetModelList();
    });
    elements.thinkingLevel.addEventListener('change', saveSettings);
    elements.customModel.addEventListener('input', () => {
        saveSettings();
        updateTranslateButton();
    });
    elements.apiBaseUrl.addEventListener('input', () => {
        saveSettings();
        updateTranslateButton();
        resetModelList();
    });
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
    // Wrapping runs on download, so it needs no reprocessing.
    elements.wrapLines.addEventListener('change', saveSettings);

    setupHints();

    // Actions
    elements.translateBtn.addEventListener('click', startTranslation);
    elements.downloadBtn.addEventListener('click', downloadResult);
    elements.exportSettingsBtn.addEventListener('click', exportSettings);
    elements.importSettingsBtn.addEventListener('click', () => elements.settingsFileInput.click());
    elements.settingsFileInput.addEventListener('change', (e) => importSettings(e.target.files[0]));

    // Initial UI state
    updateTranslateButton();
    updateTranslateButtonText();
}

// Hint buttons next to the subtitle toggles. Hover and keyboard focus show the
// tooltip through CSS; a click or tap pins it open (touch has no hover, and
// Safari does not focus buttons on click). Escape hides a visible tooltip
// until the pointer leaves or focus moves.
function setupHints() {
    const rows = Array.from(document.querySelectorAll('.toggle-row'));
    const isShown = (row) => {
        const button = row.querySelector('.hint-button');
        return row.classList.contains('hint-open') || button.matches(':hover') || button.matches(':focus-visible');
    };
    rows.forEach(row => {
        const button = row.querySelector('.hint-button');
        button.addEventListener('click', () => {
            row.classList.remove('hint-dismissed');
            row.classList.toggle('hint-open');
        });
        button.addEventListener('focus', () => row.classList.remove('hint-dismissed'));
        button.addEventListener('blur', () => row.classList.remove('hint-open', 'hint-dismissed'));
        row.addEventListener('mouseleave', () => row.classList.remove('hint-dismissed'));
    });
    document.addEventListener('keydown', (e) => {
        if (e.key !== 'Escape') return;
        rows.filter(isShown).forEach(row => {
            row.classList.remove('hint-open');
            row.classList.add('hint-dismissed');
        });
    });
    document.addEventListener('pointerdown', (e) => {
        rows.forEach(row => {
            if (row.classList.contains('hint-open') && !row.querySelector('.hint-button').contains(e.target)) {
                row.classList.remove('hint-open');
            }
        });
    });
}

function handleDragOver(e) {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
}

function handleDragLeave(e) {
    // Moving between child elements fires dragleave too; ignore those.
    if (elements.dropZone.contains(e.relatedTarget)) return;
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
        elements.dropText.textContent = `${srtBlocks.length} subtitle blocks`;
        renderPreview(srtBlocks);
    }
}

// Shows every block; the list scrolls inside the drop zone.
function renderPreview(blocks) {
    elements.filePreview.replaceChildren(...blocks.map(block => {
        const item = document.createElement('li');
        const time = document.createElement('time');
        time.textContent = block.timestamp.replace(/,\d{3}/g, '');
        const caption = document.createElement('span');
        caption.className = 'caption';
        caption.textContent = block.text.join('\n');
        item.append(time, caption);
        return item;
    }));
    elements.filePreview.classList.toggle('hidden', blocks.length === 0);
}

function processFile(file) {
    originalFileName = file.name;
    const reader = new FileReader();

    reader.onload = (e) => {
        srtContent = e.target.result;
        reprocessLoadedFile();

        elements.fileName.textContent = file.name;
        elements.fileName.classList.remove('hidden');
        elements.dropZone.classList.add('loaded');
        elements.dropZone.setAttribute('aria-label', `Loaded ${file.name}. Choose another SRT file`);

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

// Returns the chat completions URL for a user-supplied base URL, or null if
// it is not a valid http(s) URL. Accepts both ".../v1" and the full endpoint.
function chatCompletionsUrl(baseUrl) {
    let input = baseUrl.trim();
    // Allow "localhost:11434/v1" without a scheme, but only for this machine,
    // so a remote server is never silently reached over plain http.
    if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(input) && /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?(\/|$)/i.test(input)) {
        input = `http://${input}`;
    }
    let url;
    try {
        url = new URL(input);
    } catch (e) {
        return null;
    }
    if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
    // fetch() refuses URLs with embedded credentials; use the API key field instead.
    if (url.username || url.password) return null;
    const path = url.pathname.replace(/\/+$/, '');
    url.pathname = path.endsWith('/chat/completions') ? path : `${path}/chat/completions`;
    return url.toString();
}

// Returns the model list URL next to a base URL's chat completions endpoint.
function modelsUrl(baseUrl) {
    const endpoint = chatCompletionsUrl(baseUrl);
    if (!endpoint) return null;
    const url = new URL(endpoint);
    url.pathname = url.pathname.replace(/\/chat\/completions$/, '/models');
    return url.toString();
}

// Describes where the current provider lists its models, or explains why it cannot yet.
function modelListSource() {
    const provider = elements.apiProvider.value;
    const apiKey = elements.apiKey.value.trim();
    if (provider === 'openrouter') {
        // OpenRouter's list is public; the key is not needed or sent.
        return {
            key: 'openrouter',
            url: 'https://openrouter.ai/api/v1/models',
            headers: {},
            parse: (data) => (data.data || [])
                .filter(model => !model.architecture?.output_modalities || model.architecture.output_modalities.includes('text'))
                .map(model => model.id)
        };
    }
    if (provider === 'gemini') {
        if (!apiKey) return { message: 'Paste an API key to load the model list.' };
        return {
            key: `gemini|${apiKey}`,
            url: 'https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000',
            headers: { 'x-goog-api-key': apiKey },
            parse: (data) => (data.models || [])
                .filter(model => (model.supportedGenerationMethods || []).includes('generateContent'))
                .map(model => String(model.name || '').replace(/^models\//, ''))
        };
    }
    const url = modelsUrl(elements.apiBaseUrl.value);
    if (!url) return { message: 'Enter the base URL to load the model list.' };
    return {
        key: `openai|${url}|${apiKey}`,
        url,
        headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        parse: (data) => (data.data || data.models || []).map(model => model.id || model.name)
    };
}

// Fills the model suggestions for the current provider. Lists are cached, so
// reopening the field does not refetch; a failed load is retried next time.
async function loadModelList() {
    const source = modelListSource();
    if (source.message) {
        modelListKey = '';
        modelCombobox.setStatus(source.message);
        return;
    }
    if (modelListCache.has(source.key)) {
        modelListKey = source.key;
        modelCombobox.setItems(modelListCache.get(source.key));
        return;
    }
    if (modelListKey === source.key) return; // Already loading.
    modelListKey = source.key;
    const request = ++modelListRequest;
    modelCombobox.setStatus('Loading models...');

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), MODEL_LIST_TIMEOUT_MS);
    try {
        const response = await fetch(source.url, { headers: source.headers, signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const ids = source.parse(await response.json())
            .filter(id => typeof id === 'string' && id.trim())
            .map(id => id.trim());
        const models = [...new Set(ids)].sort((a, b) => a.localeCompare(b));
        if (!models.length) throw new Error('the list is empty');
        modelListCache.set(source.key, models);
        if (request === modelListRequest) modelCombobox.setItems(models);
    } catch (error) {
        if (request !== modelListRequest) return;
        modelListKey = '';
        const reason = error.name === 'AbortError' ? 'timed out' : error.message;
        modelCombobox.setStatus(`Could not load the model list (${reason}). Type the model name.`);
    } finally {
        clearTimeout(timeoutId);
    }
}

// Provider, key or base URL changed: drop the old suggestions. The new list
// loads only when the Model field is opened, never while a base URL is being
// typed, so the key is not sent to a half-typed host such as "example.co".
function resetModelList() {
    modelListRequest++;
    modelListKey = '';
    modelCombobox.setItems([]);
}

// Request fields for the chosen thinking level; empty when left at Default.
function thinkingRequestFields(provider, model, level) {
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

function isReadyToTranslate() {
    if (!srtContent || isTranslating) return false;
    if (elements.apiProvider.value === 'openai') {
        return Boolean(chatCompletionsUrl(elements.apiBaseUrl.value) && elements.customModel.value.trim());
    }
    return Boolean(elements.apiKey.value.trim());
}

function updateTranslateButton() {
    elements.translateBtn.disabled = !isReadyToTranslate();
    const url = elements.apiBaseUrl.value.trim();
    elements.apiBaseUrl.setAttribute('aria-invalid', String(Boolean(url) && !chatCompletionsUrl(url)));
}

function updateTranslateButtonText() {
    const lang = elements.targetLanguage.value;
    elements.translateBtnText.textContent = `Translate to ${lang}`;
}

function log(message, type = 'info') {
    const time = new Date().toLocaleTimeString();
    const entry = document.createElement('div');
    entry.className = 'log-entry';
    // Messages can include API error text, so never parse them as HTML.
    const timeSpan = document.createElement('span');
    timeSpan.className = 'log-time';
    timeSpan.textContent = time;
    const messageSpan = document.createElement('span');
    messageSpan.className = `log-${type}`;
    messageSpan.textContent = message;
    entry.append(timeSpan, messageSpan);
    elements.logContainer.insertBefore(entry, elements.logContainer.firstChild);
}

function updateProgress(completed, failed, total) {
    elements.completedChunks.textContent = completed;
    elements.failedChunks.textContent = failed;
    elements.progressCard.classList.toggle('has-failed', failed > 0);

    const percent = total > 0 ? Math.round((completed + failed) / total * 100) : 0;
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

async function translateChunk(chunk, index, apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinkingLevel) {
    // Extract text with block markers
    const markedText = extractTextWithMarkers(chunk);
    const systemPrompt = buildSystemPrompt(targetLanguage, customInstructions);

    console.log(`[Chunk ${index + 1}] Sending API request...`);

    // Create abort controller for timeout
    // Thinking adds time before the first token, so give it the longer timeout too.
    const timeoutMs = provider === 'openai' || thinkingLevel ? CUSTOM_SERVER_TIMEOUT_MS : REQUEST_TIMEOUT_MS;
    const thinking = thinkingRequestFields(provider, model, thinkingLevel);
    const controller = new AbortController();
    const timeoutId = setTimeout(() => {
        console.log(`[Chunk ${index + 1}] TIMEOUT - aborting request`);
        controller.abort();
    }, timeoutMs);

    try {
        let response;
        if (OPENAI_STYLE_PROVIDERS.includes(provider)) {
            const headers = { 'Content-Type': 'application/json' };
            // Self-hosted servers often run without auth; send a key only if one is set.
            if (apiKey) headers['Authorization'] = `Bearer ${apiKey}`;
            if (provider === 'openrouter') {
                headers['HTTP-Referer'] = window.location.origin && window.location.origin !== 'null' ? window.location.origin : 'https://github.com/AmiraliNotFound/better-ai-srt-translation';
                headers['X-Title'] = 'Better AI SRT Translation';
            }
            response = await fetch(provider === 'openrouter' ? 'https://openrouter.ai/api/v1/chat/completions' : endpoint, {
                method: 'POST',
                headers,
                body: JSON.stringify({
                    model: model,
                    messages: [
                        { role: 'system', content: systemPrompt },
                        { role: 'user', content: markedText }
                    ],
                    // OpenAI reasoning models reject any temperature but the default.
                    ...(thinkingLevel ? {} : { temperature: 0.3 }),
                    ...thinking
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
                        temperature: 0.3,
                        ...thinking
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
            // OpenAI-style servers announce rate-limit cooldowns in Retry-After (seconds).
            const retryAfter = parseFloat(response.headers.get('Retry-After'));
            throw new APIError(response.status, message, details, Number.isFinite(retryAfter) ? retryAfter : null);
        }

        const data = await response.json();
        console.log(`[Chunk ${index + 1}] Parsed response, parsing markers...`);

        let translatedText;
        if (OPENAI_STYLE_PROVIDERS.includes(provider)) {
            if (!data.choices || data.choices.length === 0 || !data.choices[0].message || !data.choices[0].message.content) {
                throw new Error(`Invalid or empty response structure from ${provider === 'openai' ? 'the server' : 'OpenRouter'}`);
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
                // Replace English commas not between digits with Arabic/Persian comma
                text = text.replace(/(?<!\d),|,(?!\d)/g, '،');
                // Replace English question mark with Arabic/Persian question mark
                text = text.replace(/\?/g, '؟');
                // Replace English semicolon with Arabic/Persian semicolon
                text = text.replace(/;/g, '؛');

                text = text.split('\n').map(formatRTLLine).join('\n');
            }
            return `${block.index}\n${block.timestamp}\n${text}`;
        }).join('\n\n');

    } catch (error) {
        clearTimeout(timeoutId);
        console.log(`[Chunk ${index + 1}] Error:`, error.name, error.message);
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        }
        throw error;
    }
}

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

// Retry wrapper with exponential backoff, and smart rate-limit (429) delay handling
async function translateChunkWithRetry(chunk, index, apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinkingLevel, onRetry) {
    let lastError;
    let maxAttempts = MAX_RETRIES;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await translateChunk(chunk, index, apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinkingLevel);
        } catch (error) {
            lastError = error;

            if (attempt < maxAttempts) {
                let delay = RETRY_DELAY_MS * Math.pow(2, attempt - 1); // Exponential backoff

                // Smart handling of 429 Rate Limits
                if (error.status === 429) {
                    // Increase max attempts for rate limit retries to give it more chances
                    maxAttempts = Math.max(maxAttempts, 8);
                    
                    let retrySeconds = error.retryAfterSeconds ?? 60; // Default fallback wait is 60 seconds
                    
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
    if (!isReadyToTranslate()) return;
    isTranslating = true;
    try {
        await runTranslation();
    } finally {
        isTranslating = false;
        updateTranslateButton();
    }
}

async function runTranslation() {
    const apiKey = elements.apiKey.value.trim();

    // Get settings
    const provider = elements.apiProvider.value;
    const defaultModel = provider === 'openrouter' ? DEFAULT_MODEL_OPENROUTER : DEFAULT_MODEL_GEMINI;
    const model = elements.customModel.value.trim() || defaultModel;
    const endpoint = provider === 'openai' ? chatCompletionsUrl(elements.apiBaseUrl.value) : null;
    const targetLanguage = elements.targetLanguage.value;
    const targetChunkSize = parseInt(elements.chunkSize.value) || 50;
    const maxParallel = parseInt(elements.parallelRequests.value) || DEFAULT_PARALLEL;
    const customInstructions = elements.customInstructions.value;
    const thinkingLevel = elements.thinkingLevel.value;

    // Create chunks
    const chunks = createSmartChunks(srtBlocks, targetChunkSize);

    // Setup UI
    elements.progressCard.classList.remove('hidden');
    elements.downloadBtn.classList.add('hidden');
    elements.translateBtn.disabled = true;
    elements.logContainer.innerHTML = '';

    elements.totalChunks.textContent = chunks.length;
    updateProgress(0, 0, chunks.length);

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
    log(thinkingLevel ? `Model: ${model} | Thinking: ${thinkingLevel}` : `Model: ${model}`, 'info');
    if (provider === 'openai') log(`Endpoint: ${endpoint}`, 'info');
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
                endpoint,
                thinkingLevel,
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

    elements.downloadBtn.classList.remove('hidden');
}

// ============================================
// Download
// ============================================

function downloadResult() {
    const lang = elements.targetLanguage.value;
    const langCode = getLanguageCode(lang);

    const output = elements.wrapLines.checked ? wrapSRT(translatedResult) : translatedResult;
    const blob = new Blob([output], { type: 'text/plain;charset=utf-8' });
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

// ============================================
// Line Wrapping
// ============================================

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

// Applies wrapSubtitleLines to the translated SRT, whose blocks are always
// "index, timestamp, text lines" separated by one blank line. It splits on
// that instead of calling parseSRT, which would read a line of digits as a
// new block. Arabic and Persian lines carry bidi marks per line, so those are
// stripped before wrapping and put back on every new line.
function wrapSRT(content) {
    return content.split(/\n\n+/).map(block => {
        const [index, timestamp, ...text] = block.split('\n');
        if (text.length === 0) return block;
        const isRTL = text.some(line => line.startsWith(RLM));
        const plain = isRTL ? text.map(line => line.replace(/[\u200F\u202B\u202C]/g, '')) : text;
        const wrapped = wrapSubtitleLines(plain);
        if (wrapped === plain) return block;
        return [index, timestamp, ...(isRTL ? wrapped.map(formatRTLLine) : wrapped)].join('\n');
    }).join('\n\n');
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
