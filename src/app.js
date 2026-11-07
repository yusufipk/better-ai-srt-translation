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
const SETTINGS_FILE_FORMAT = 'better-ai-srt-translation-settings';
const SETTINGS_FILE_VERSION = 1;
const SETTINGS_FILE_MAX_BYTES = 1024 * 1024;
const THINKING_LEVELS = ['low', 'medium', 'high'];
// Gemini 2.5 takes a token budget instead of a level.
const GEMINI_THINKING_BUDGETS = { low: 1024, medium: 8192, high: 24576 };
const MODEL_LIST_TIMEOUT_MS = 15000;
// A subtitle file is a few hundred KB at most; anything far larger is not one.
const MAX_SRT_BYTES = 20 * 1024 * 1024;
// Guards against a dropped folder tree that links back into itself.
const MAX_FOLDER_DEPTH = 32;

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
// One job per file: { id, name, path, key, content, blockCount, status,
// result, langCode, failedChunks, totalChunks, error }. Status is 'queued',
// 'translating', 'done', 'partial' (some chunks kept their original text) or
// 'failed' (nothing usable came back).
let jobs = [];
let nextJobId = 1;
let selectedJobId = null;
let activeJob = null;
// Aborted by the Stop button.
let queueAbort = null;
let dropStatusTimer = null;
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
    stopBtn: document.getElementById('stopBtn'),
    progressCard: document.getElementById('progressCard'),
    progressTitle: document.getElementById('progressTitle'),
    downloadBtn: document.getElementById('downloadBtn'),
    downloadBtnText: document.getElementById('downloadBtnText'),
    dropStatus: document.getElementById('dropStatus'),
    queueCard: document.getElementById('queueCard'),
    queueList: document.getElementById('queueList'),
    queueSummary: document.getElementById('queueSummary'),
    clearQueueBtn: document.getElementById('clearQueueBtn'),
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
    elements.stopBtn.addEventListener('click', stopTranslation);
    elements.downloadBtn.addEventListener('click', downloadAll);
    elements.clearQueueBtn.addEventListener('click', clearQueue);
    elements.queueList.addEventListener('click', handleQueueClick);
    // Results live only in this tab, so closing it would lose them.
    window.addEventListener('beforeunload', (e) => {
        if (isTranslating || jobs.some(job => job.result && !job.downloaded)) e.preventDefault();
    });
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
    // Entries must be taken before the first await; the browser empties the
    // drop data once the event handler returns.
    addFiles(filesFromDrop(e.dataTransfer));
}

function handleFileSelect(e) {
    const files = Array.from(e.target.files).map(file => ({ file, path: file.name }));
    // Allow choosing the same files again.
    e.target.value = '';
    addFiles(Promise.resolve(files));
}

// Lists dropped files with their path inside any dropped folder. Folders are
// walked recursively; an entry that cannot be read is skipped, not fatal.
function filesFromDrop(dataTransfer) {
    const items = Array.from(dataTransfer.items || []).filter(item => item.kind === 'file');
    const entries = items.map(item => item.webkitGetAsEntry && item.webkitGetAsEntry()).filter(Boolean);
    if (entries.length === 0) {
        return Promise.resolve(Array.from(dataTransfer.files).map(file => ({ file, path: file.name })));
    }
    const found = [];
    found.unreadable = 0;
    const walk = async (entry, depth) => {
        try {
            if (entry.isFile) {
                const file = await new Promise((resolve, reject) => entry.file(resolve, reject));
                found.push({ file, path: entry.fullPath.replace(/^\/+/, '') || file.name });
            } else if (entry.isDirectory && depth >= MAX_FOLDER_DEPTH) {
                found.unreadable++;
            } else if (entry.isDirectory) {
                const reader = entry.createReader();
                // readEntries returns at most about 100 entries per call.
                for (;;) {
                    const batch = await new Promise((resolve, reject) => reader.readEntries(resolve, reject));
                    if (batch.length === 0) break;
                    for (const child of batch) await walk(child, depth + 1);
                }
            }
        } catch (error) {
            // Counted, so the summary says something was missed.
            found.unreadable++;
            console.warn(`Could not read ${entry.fullPath}:`, error);
        }
    };
    return (async () => {
        for (const entry of entries) await walk(entry, 0);
        return found;
    })();
}

function isSrtName(name) {
    return /\.srt$/i.test(name);
}

// Adds .srt files to the queue in path order, so "Episode 2" comes before
// "Episode 10". Other files, oversized files and files already in the list
// are skipped and counted.
async function addFiles(filesPromise) {
    let candidates;
    try {
        candidates = await filesPromise;
    } catch (error) {
        showDropStatus(`Could not read the dropped items: ${error.message}`, true);
        return;
    }
    const known = new Set(jobs.map(job => job.key));
    const jobsBefore = jobs.length;
    let notSrt = 0;
    let tooLarge = 0;
    let duplicate = 0;
    const accepted = [];
    for (const { file, path } of candidates) {
        if (!isSrtName(file.name)) { notSrt++; continue; }
        if (file.size > MAX_SRT_BYTES) { tooLarge++; continue; }
        const key = `${path}|${file.size}|${file.lastModified}`;
        if (known.has(key)) { duplicate++; continue; }
        known.add(key);
        accepted.push({ file, path, key });
    }
    accepted.sort((a, b) => a.path.localeCompare(b.path, undefined, { numeric: true, sensitivity: 'base' }));

    const read = await Promise.all(accepted.map(async ({ file, path, key }) => {
        try {
            return { file, path, key, content: await file.text() };
        } catch (error) {
            return { file, path, key, error };
        }
    }));
    let unreadable = candidates.unreadable || 0;
    for (const item of read) {
        if (item.error) { unreadable++; continue; }
        // Another drop may have added the same file while this one was reading.
        if (jobs.some(job => job.key === item.key)) { duplicate++; continue; }
        const job = {
            id: nextJobId++,
            name: item.file.name,
            path: item.path,
            key: item.key,
            content: item.content,
            blockCount: 0,
            status: 'queued',
            result: null,
            langCode: '',
            failedChunks: 0,
            totalChunks: 0,
            error: '',
            doneChunks: 0,
            downloaded: false
        };
        job.blockCount = prepareBlocks(job.content).length;
        jobs.push(job);
        if (selectedJobId === null) selectedJobId = job.id;
    }
    // Show the first new file, unless a translation is being watched.
    const added = jobs.length - jobsBefore;
    if (added > 0 && !isTranslating) selectedJobId = jobs[jobs.length - added].id;

    const skipped = [
        notSrt && `${notSrt} not .srt`,
        tooLarge && `${tooLarge} over ${MAX_SRT_BYTES / 1024 / 1024} MB`,
        duplicate && `${duplicate} already in the list`,
        unreadable && `${unreadable} unreadable`
    ].filter(Boolean);
    if (added === 0 && skipped.length === 0) showDropStatus('No .srt files found.', true);
    else if (skipped.length) showDropStatus(`${added} added, skipped ${skipped.join(', ')}.`, added === 0);
    else if (added > 1) showDropStatus(`${added} files added.`);
    else showDropStatus('');

    renderWorkspace();
}

function showDropStatus(message, isError = false) {
    clearTimeout(dropStatusTimer);
    elements.dropStatus.textContent = message;
    elements.dropStatus.classList.toggle('error', isError);
    if (message && !isError) dropStatusTimer = setTimeout(() => { elements.dropStatus.textContent = ''; }, 6000);
}

// ============================================
// File Processing
// ============================================

// Parses a file and applies the merge and timing switches. Reads the switches
// unless a settings snapshot from the start of a translation is given.
function prepareBlocks(content, options = null) {
    const merge = options ? options.mergeSubtitles : elements.mergeSubtitles.checked;
    const optimize = options ? options.optimizeTimings : elements.optimizeTimings.checked;
    const blocks = parseSRT(content);
    if (merge) mergeShortSubtitles(blocks);
    if (optimize) optimizeTimings(blocks);
    return blocks;
}

// The merge and timing switches changed: recount files that have not been
// translated yet and refresh the preview.
function reprocessLoadedFile() {
    for (const job of jobs) {
        if (job.status === 'queued') job.blockCount = prepareBlocks(job.content).length;
    }
    elements.filePreview.dataset.stale = 'true';
    renderWorkspace();
}

function selectedJob() {
    return jobs.find(job => job.id === selectedJobId) || null;
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

// Redraws everything that depends on the file list.
function renderWorkspace() {
    const job = selectedJob();
    const shown = job ? job.id : null;
    if (elements.filePreview.dataset.job !== String(shown) || elements.filePreview.dataset.stale === 'true') {
        const blocks = job ? prepareBlocks(job.content) : [];
        renderPreview(blocks);
        elements.dropText.textContent = job ? `${blocks.length} subtitle blocks` : '';
        elements.filePreview.dataset.job = String(shown);
        elements.filePreview.dataset.stale = 'false';
    }
    elements.fileName.textContent = job ? job.path : '';
    elements.fileName.classList.toggle('hidden', !job);
    elements.dropZone.classList.toggle('loaded', Boolean(job));
    elements.dropZone.setAttribute('aria-label', job ? `Showing ${job.path}. Add more SRT files` : 'Add SRT files');

    renderQueue();
    updateTranslateButton();
    updateDownloadButton();
}

const STATUS_LABELS = { queued: 'Queued', translating: 'Translating', done: 'Done', partial: 'Partly translated', failed: 'Failed' };

const ICONS = {
    download: '<path d="M12 4v11m0 0-4-4m4 4 4-4" /><path d="M4 17v1a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-1" />',
    retry: '<path d="M4 12a8 8 0 0 1 14-5.3L20 9" /><path d="M20 4v5h-5" /><path d="M20 12a8 8 0 0 1-14 5.3L4 15" /><path d="M4 20v-5h5" />',
    remove: '<path d="M6 6l12 12M18 6 6 18" />'
};

function iconButton(action, label, jobId) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'icon-button';
    button.dataset.action = action;
    button.dataset.job = jobId;
    button.title = label;
    button.setAttribute('aria-label', label);
    // ICONS holds fixed markup from this file, never file names or API text.
    button.innerHTML = `<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[action]}</svg>`;
    return button;
}

function jobDetail(job) {
    if (job.error && job.result) return job.error;
    if (job.status === 'queued') return job.result ? `${job.blockCount} blocks, ${job.langCode} result kept until replaced` : `${job.blockCount} blocks`;
    if (job.status === 'translating') return 'Starting';
    if (job.status === 'done') return job.langCode;
    if (job.status === 'partial') return `${job.failedChunks} of ${job.totalChunks} chunks kept the original text`;
    return job.error || 'Failed';
}

// The list appears once there is more than one file. Every row carries its
// own download, retry and remove buttons, so one failed file never blocks
// the others.
function renderQueue() {
    elements.queueCard.classList.toggle('hidden', jobs.length < 2);
    const finished = jobs.filter(job => job.result).length;
    elements.queueSummary.textContent = `${finished} of ${jobs.length} ready`;
    updateDownloadButton();
    elements.clearQueueBtn.disabled = isTranslating;

    elements.queueList.replaceChildren(...jobs.map(job => {
        const item = document.createElement('li');
        item.className = `queue-item ${job.status}`;
        item.dataset.job = job.id;
        if (job.id === selectedJobId) item.classList.add('selected');

        const dot = document.createElement('span');
        dot.className = 'queue-dot';
        dot.title = STATUS_LABELS[job.status];
        dot.setAttribute('role', 'img');
        dot.setAttribute('aria-label', STATUS_LABELS[job.status]);

        const name = document.createElement('button');
        name.type = 'button';
        name.className = 'queue-name';
        name.dataset.action = 'select';
        name.dataset.job = job.id;
        name.textContent = job.path;
        name.title = `Preview ${job.path}`;

        const detail = document.createElement('span');
        detail.className = 'queue-detail';
        detail.textContent = jobDetail(job);
        if (job.status === 'failed' || job.status === 'partial' || job.error) detail.title = detail.textContent;
        if (job.error) item.classList.add('has-error');

        const actions = document.createElement('span');
        actions.className = 'queue-actions';
        if (job.result) actions.append(iconButton('download', `Download ${outputName(job)}`, job.id));
        if ((job.status === 'failed' || job.status === 'partial' || job.error) && job !== activeJob && job.status !== 'queued') actions.append(iconButton('retry', 'Translate this file again', job.id));
        if (job !== activeJob) actions.append(iconButton('remove', 'Remove from the list', job.id));

        item.append(dot, name, detail, actions);
        return item;
    }));
}

function handleQueueClick(e) {
    const button = e.target.closest('button[data-action]');
    if (!button) return;
    const job = jobs.find(item => item.id === Number(button.dataset.job));
    if (!job) return;
    const action = button.dataset.action;
    if (action === 'select') {
        selectedJobId = job.id;
    } else if (action === 'download') {
        downloadJob(job);
        return;
    } else if (action === 'retry') {
        resetJob(job);
        // A running queue picks it up on its own; otherwise Translate does.
    } else if (action === 'remove') {
        if (job === activeJob) return;
        if (job.result && !job.downloaded && !confirm(`${job.path} has a translation that was not downloaded. Remove it anyway?`)) return;
        jobs = jobs.filter(item => item !== job);
        if (selectedJobId === job.id) selectedJobId = jobs.length ? jobs[0].id : null;
    }
    renderWorkspace();
}

function clearQueue() {
    if (isTranslating) return;
    const unsaved = jobs.filter(job => job.result && !job.downloaded).length;
    if (unsaved && !confirm(`${unsaved === 1 ? 'A translated file has' : `${unsaved} translated files have`} not been downloaded. Clear the list anyway?`)) return;
    jobs = [];
    selectedJobId = null;
    showDropStatus('');
    elements.progressCard.classList.add('hidden');
    renderWorkspace();
}

// Puts a file back in the queue. A result it already has stays downloadable
// until a new run replaces it, so a retry that fails or is stopped never
// loses the earlier translation.
function resetJob(job) {
    if (job.status !== 'queued' && job.status !== 'translating') job.previousStatus = job.result ? job.status : null;
    job.status = 'queued';
    job.doneChunks = 0;
    job.error = '';
    job.blockCount = prepareBlocks(job.content).length;
}

// A rerun failed or stopped: go back to the earlier result if there is one.
function restoreJob(job, message) {
    if (job.result && job.previousStatus) {
        job.status = job.previousStatus;
        job.error = message ? `${message}; the earlier ${job.langCode} result is kept` : '';
    } else {
        job.status = message ? 'failed' : 'queued';
        job.error = message || '';
    }
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
    if (isTranslating || jobs.length === 0) return false;
    if (elements.apiProvider.value === 'openai') {
        return Boolean(chatCompletionsUrl(elements.apiBaseUrl.value) && elements.customModel.value.trim());
    }
    return Boolean(elements.apiKey.value.trim());
}

function updateTranslateButton() {
    elements.translateBtn.disabled = !isReadyToTranslate();
    updateTranslateButtonText();
    const url = elements.apiBaseUrl.value.trim();
    elements.apiBaseUrl.setAttribute('aria-invalid', String(Boolean(url) && !chatCompletionsUrl(url)));
}

function updateTranslateButtonText() {
    const lang = elements.targetLanguage.value;
    const queued = jobs.filter(job => job.status === 'queued').length;
    if (isTranslating) {
        elements.translateBtnText.textContent = queued ? `Translating, ${queued} more queued` : 'Translating...';
    } else if (queued === 0 && jobs.length > 1) {
        elements.translateBtnText.textContent = `Translate all ${jobs.length} files again to ${lang}`;
    } else {
        elements.translateBtnText.textContent = queued > 1 ? `Translate ${queued} files to ${lang}` : `Translate to ${lang}`;
    }
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

async function translateChunk(chunk, index, apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinkingLevel, stopSignal) {
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
    const onStop = () => controller.abort();
    stopSignal?.addEventListener('abort', onStop);

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
        if (stopSignal?.aborted) throw stopSignal.reason;
        if (error.name === 'AbortError') {
            throw new Error(`Request timed out after ${timeoutMs / 1000}s`);
        }
        throw error;
    } finally {
        stopSignal?.removeEventListener('abort', onStop);
    }
}

// Resolves after ms, or rejects at once when the stop signal fires.
function waitOrStop(ms, stopSignal) {
    return new Promise((resolve, reject) => {
        if (stopSignal?.aborted) return reject(stopSignal.reason);
        const onStop = () => {
            clearTimeout(timer);
            reject(stopSignal.reason);
        };
        const timer = setTimeout(() => {
            stopSignal?.removeEventListener('abort', onStop);
            resolve();
        }, ms);
        stopSignal?.addEventListener('abort', onStop, { once: true });
    });
}

// Retry wrapper with exponential backoff, and smart rate-limit (429) delay handling
async function translateChunkWithRetry(chunk, index, apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinkingLevel, onRetry, stopSignal) {
    let lastError;
    let maxAttempts = MAX_RETRIES;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
        try {
            return await translateChunk(chunk, index, apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinkingLevel, stopSignal);
        } catch (error) {
            if (stopSignal?.aborted) throw stopSignal.reason;
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
                await waitOrStop(delay, stopSignal);
            }
        }
    }

    throw lastError;
}

// ============================================
// Main Translation Flow
// ============================================

class StopRequested extends Error {
    constructor() {
        super('Stopped');
        this.name = 'StopRequested';
    }
}

// Translates queued files one after another until none is left. Files added
// or retried while it runs join the queue. Every file has its own try/catch,
// so an error in one marks only that file failed and the next one starts.
async function startTranslation() {
    if (!isReadyToTranslate()) return;
    // Nothing queued: translate every file again, e.g. into another language.
    if (!jobs.some(job => job.status === 'queued')) {
        const unsaved = jobs.filter(job => job.result && !job.downloaded).length;
        if (unsaved && !confirm(`${unsaved === 1 ? 'A translated file has' : `${unsaved} translated files have`} not been downloaded. Translate again and replace ${unsaved === 1 ? 'it' : 'them'}?`)) return;
        jobs.forEach(resetJob);
    }
    isTranslating = true;
    queueAbort = new AbortController();
    lockSettings(true);
    const settings = translationSettings();
    elements.stopBtn.classList.remove('hidden');
    elements.logContainer.innerHTML = '';
    log(`Starting translation to ${settings.targetLanguage}...`, 'info');
    log(settings.thinkingLevel ? `Model: ${settings.model} | Thinking: ${settings.thinkingLevel}` : `Model: ${settings.model}`, 'info');
    if (settings.provider === 'openai') log(`Endpoint: ${settings.endpoint}`, 'info');
    renderWorkspace();
    try {
        for (;;) {
            const job = jobs.find(item => item.status === 'queued');
            if (!job || queueAbort.signal.aborted) break;
            await runJob(job, settings, queueAbort.signal);
        }
    } finally {
        activeJob = null;
        isTranslating = false;
        queueAbort = null;
        elements.stopBtn.classList.add('hidden');
        lockSettings(false);
        const ready = jobs.filter(job => job.result).length;
        const failed = jobs.filter(job => job.status === 'failed').length;
        if (jobs.length > 1) log(`Queue finished: ${ready} of ${jobs.length} files ready${failed ? `, ${failed} failed` : ''}`, failed ? 'error' : 'success');
        renderWorkspace();
    }
}

// A run uses the settings it started with, so the fields that shape a
// translation are locked until it ends. Break long lines stays free: it
// applies on download.
function lockSettings(locked) {
    [elements.apiProvider, elements.apiKey, elements.customModel, elements.apiBaseUrl, elements.thinkingLevel,
        elements.targetLanguage, elements.chunkSize, elements.parallelRequests, elements.customInstructions,
        elements.mergeSubtitles, elements.optimizeTimings, elements.importSettingsBtn].forEach(control => { control.disabled = locked; });
    dropdowns.forEach(dropdown => dropdown.sync());
}

function stopTranslation() {
    if (!queueAbort || queueAbort.signal.aborted) return;
    queueAbort.abort(new StopRequested());
    log('Stopping...', 'error');
}

// Read once per run, so changing a field mid-queue cannot give one batch two
// languages or send half the files to another server.
function translationSettings() {
    const provider = elements.apiProvider.value;
    const defaultModel = provider === 'openrouter' ? DEFAULT_MODEL_OPENROUTER : DEFAULT_MODEL_GEMINI;
    return {
        apiKey: elements.apiKey.value.trim(),
        provider,
        model: elements.customModel.value.trim() || defaultModel,
        endpoint: provider === 'openai' ? chatCompletionsUrl(elements.apiBaseUrl.value) : null,
        targetLanguage: elements.targetLanguage.value,
        targetChunkSize: parseInt(elements.chunkSize.value) || 50,
        maxParallel: parseInt(elements.parallelRequests.value) || DEFAULT_PARALLEL,
        customInstructions: elements.customInstructions.value,
        thinkingLevel: elements.thinkingLevel.value,
        mergeSubtitles: elements.mergeSubtitles.checked,
        optimizeTimings: elements.optimizeTimings.checked
    };
}

// Updates one row's text only; rebuilding the list would move keyboard focus.
function updateJobDetail(job, text) {
    const detail = elements.queueList.querySelector(`.queue-item[data-job="${job.id}"] .queue-detail`);
    if (detail) detail.textContent = text;
}

async function runJob(job, settings, stopSignal) {
    activeJob = job;
    job.status = 'translating';
    job.error = '';
    job.doneChunks = 0;
    selectedJobId = job.id;
    renderWorkspace();
    const position = jobs.indexOf(job) + 1;
    elements.progressTitle.textContent = jobs.length > 1 ? `${job.path} (${position} of ${jobs.length})` : 'Progress';
    log(`File: ${job.path}`, 'info');

    try {
        const blocks = prepareBlocks(job.content, settings);
        if (blocks.length === 0) throw new Error('No subtitle blocks found');
        // Progress goes into its own counter, so a kept earlier result keeps its numbers.
        let total = 0;
        const outcome = await translateBlocks(blocks, settings, stopSignal, (done) => {
            job.doneChunks = done;
            updateJobDetail(job, `${done} of ${total} chunks`);
        }, (count) => {
            total = count;
            updateJobDetail(job, `0 of ${total} chunks`);
        });
        if (outcome.completed === 0) {
            restoreJob(job, outcome.lastError ? `Every chunk failed: ${outcome.lastError}` : 'Every chunk failed');
        } else {
            job.result = outcome.srt;
            job.langCode = getLanguageCode(settings.targetLanguage);
            job.failedChunks = outcome.failed;
            job.totalChunks = outcome.total;
            job.downloaded = false;
            job.previousStatus = null;
            job.status = outcome.failed ? 'partial' : 'done';
        }
        log(`${job.path}: ${outcome.completed} chunks translated, ${outcome.failed} failed`, outcome.failed ? 'error' : 'success');
    } catch (error) {
        if (error instanceof StopRequested) {
            // Unfinished work is dropped; the file waits for the next run.
            job.status = 'queued';
            job.doneChunks = 0;
            log(`${job.path}: stopped, back in the queue`, 'error');
        } else {
            restoreJob(job, error.message || String(error));
            log(`${job.path} FAILED: ${error.message || error}`, 'error');
        }
    } finally {
        activeJob = null;
        renderWorkspace();
    }
}

// Translates one file's blocks with bounded parallelism. A chunk that fails
// after its retries keeps its original text, so the file is always complete.
async function translateBlocks(blocks, settings, stopSignal, onProgress, onChunks) {
    const { apiKey, provider, model, endpoint, targetLanguage, targetChunkSize, maxParallel, customInstructions, thinkingLevel } = settings;
    const chunks = createSmartChunks(blocks, targetChunkSize);
    onChunks(chunks.length);

    elements.progressCard.classList.remove('hidden');
    elements.totalChunks.textContent = chunks.length;
    updateProgress(0, 0, chunks.length);
    elements.chunksGrid.innerHTML = '';
    chunks.forEach((_, i) => {
        const indicator = document.createElement('div');
        indicator.className = 'chunk-indicator pending';
        indicator.dataset.chunk = i;
        indicator.textContent = i + 1;
        elements.chunksGrid.appendChild(indicator);
    });
    log(`Chunks: ${chunks.length} | Size: ~${targetChunkSize} | Parallel: ${maxParallel}`, 'info');

    let completed = 0;
    let failed = 0;
    let lastError = '';
    const results = new Array(chunks.length).fill(null);

    async function processChunk(chunk, index) {
        setChunkStatus(index, 'processing');
        const textLength = chunk.reduce((sum, b) => sum + b.text.join(' ').length, 0);
        try {
            log(`Chunk ${index + 1} starting (${chunk.length} blocks, ${textLength} chars)...`, 'info');
            results[index] = await translateChunkWithRetry(
                chunk, index, apiKey, model, targetLanguage, customInstructions, provider, endpoint, thinkingLevel,
                (idx, attempt, delay) => {
                    setChunkStatus(idx, 'error');
                    log(`Chunk ${idx + 1} rate limited/failed. Retrying (attempt ${attempt}) in ${Math.round(delay / 1000)}s...`, 'error');
                    setTimeout(() => { if (!stopSignal.aborted) setChunkStatus(idx, 'processing'); }, 100);
                },
                stopSignal
            );
            completed++;
            setChunkStatus(index, 'done');
            log(`Chunk ${index + 1} completed`, 'success');
        } catch (error) {
            if (stopSignal.aborted) throw stopSignal.reason;
            failed++;
            lastError = error.message;
            setChunkStatus(index, 'error');
            log(`Chunk ${index + 1} FAILED: ${error.message}`, 'error');
            results[index] = blocksToSRT(chunk);
        }
        updateProgress(completed, failed, chunks.length);
        onProgress(completed, failed);
    }

    // Workers pull the next chunk until none is left. allSettled waits for
    // every request, so a stop never leaves one writing into the next file's
    // progress grid.
    let nextIndex = 0;
    const worker = async () => {
        while (nextIndex < chunks.length && !stopSignal.aborted) {
            const index = nextIndex++;
            await processChunk(chunks[index], index);
        }
    };
    const outcomes = await Promise.allSettled(Array.from({ length: Math.min(maxParallel, chunks.length) }, worker));
    if (stopSignal.aborted) throw stopSignal.reason;
    const crash = outcomes.find(outcome => outcome.status === 'rejected');
    if (crash) throw crash.reason;

    return { srt: results.join('\n\n'), completed, failed, lastError, total: chunks.length };
}

// ============================================
// Download
// ============================================

function outputName(job) {
    return /\.srt$/i.test(job.name) ? job.name.replace(/\.srt$/i, `_${job.langCode}.srt`) : `${job.name}_${job.langCode}.srt`;
}

function outputPath(job) {
    const folder = job.path.includes('/') ? job.path.slice(0, job.path.lastIndexOf('/') + 1) : '';
    return folder + outputName(job);
}

// Line breaking applies at download time, so the switch can change after translating.
function outputText(job) {
    return elements.wrapLines.checked ? wrapSRT(job.result) : job.result;
}

function saveBlob(blob, fileName) {
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = fileName;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    // Some browsers start the download asynchronously; revoke a little later.
    setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadJob(job) {
    if (!job.result) return;
    saveBlob(new Blob([outputText(job)], { type: 'text/plain;charset=utf-8' }), outputName(job));
    job.downloaded = true;
    log(`Downloaded: ${outputName(job)}`, 'success');
}

// One finished file downloads as is; several go into one ZIP that keeps the
// folder layout they were dropped with. Failed files are left out, and
// partly translated ones go in, with their untranslated chunks as they were.
function downloadAll() {
    const ready = jobs.filter(job => job.result);
    if (ready.length === 0) return;
    if (ready.length === 1) {
        downloadJob(ready[0]);
        return;
    }
    let zip;
    try {
        zip = createZip(ready.map(job => ({ name: outputPath(job), data: outputText(job) })));
    } catch (error) {
        // The finished files stay downloadable one by one from the list.
        log(`Could not build the ZIP: ${error.message}. Download the files one by one instead.`, 'error');
        elements.progressCard.classList.remove('hidden');
        return;
    }
    const codes = [...new Set(ready.map(job => job.langCode))];
    const zipName = `translated_${codes.length === 1 ? codes[0] : 'subtitles'}.zip`;
    saveBlob(new Blob([zip], { type: 'application/zip' }), zipName);
    ready.forEach(job => { job.downloaded = true; });
    log(`Downloaded: ${zipName} (${ready.length} files)`, 'success');
}

function updateDownloadButton() {
    const ready = jobs.filter(job => job.result).length;
    elements.downloadBtn.classList.toggle('hidden', ready === 0);
    if (ready > 1) elements.downloadBtnText.textContent = `Download all (${ready} files, ZIP)`;
    else elements.downloadBtnText.textContent = jobs.length > 1 ? 'Download the finished file' : 'Download translated SRT';
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
