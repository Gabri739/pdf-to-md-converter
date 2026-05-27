/**
 * PDF-to-MD OCR WebApp - Frontend Logic
 * Updated for job-based API with streaming OCR
 */

const API_BASE = window.location.origin;

// State Management
const state = {
    jobId: null,
    filename: '',
    totalPages: 0,
    currentPage: 1,  // 1-indexed
    results: {},     // { pageNum: { status, markdown, error } }
    isProcessing: false,
    isRawView: false
};

// DOM Elements
const elements = {
    fileInput: document.getElementById('fileInput'),
    uploadBtn: document.getElementById('uploadBtn'),
    processAllBtn: document.getElementById('processAllBtn'),
    downloadBtn: document.getElementById('downloadBtn'),
    clearBtn: document.getElementById('clearBtn'),
    statusBadge: document.getElementById('statusBadge'),
    uploadScreen: document.getElementById('uploadScreen'),
    dropZone: document.getElementById('dropZone'),

    mainView: document.getElementById('mainView'),

    thumbnailsContainer: document.getElementById('thumbnailsContainer'),
    currentPageImg: document.getElementById('currentPageImg'),
    pageCounter: document.getElementById('pageCounter'),
    prevPageBtn: document.getElementById('prevPageBtn'),
    nextPageBtn: document.getElementById('nextPageBtn'),

    ocrStatus: document.getElementById('ocrStatus'),
    markdownBody: document.getElementById('markdownBody'),
    rawEditor: document.getElementById('rawEditor'),
    toggleViewBtn: document.getElementById('toggleViewBtn'),
    copyBtn: document.getElementById('copyBtn'),
    processPageBtn: document.getElementById('processPageBtn'),

    progressBar: document.getElementById('progressBar'),
    loadingOverlay: document.getElementById('loadingOverlay'),
    loadingText: document.getElementById('loadingText')
};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    setupEventListeners();
    checkHealth();
    setInterval(checkHealth, 30000);
});

function setupEventListeners() {
    // Upload
    elements.uploadBtn.addEventListener('click', () => elements.fileInput.click());
    elements.fileInput.addEventListener('change', handleFileSelect);

    // Drag & Drop
    elements.dropZone.addEventListener('dragover', handleDragOver);
    elements.dropZone.addEventListener('dragleave', handleDragLeave);
    elements.dropZone.addEventListener('drop', handleDrop);
    elements.dropZone.addEventListener('click', () => elements.fileInput.click());

    // Navigation
    elements.prevPageBtn.addEventListener('click', () => navigatePage(-1));
    elements.nextPageBtn.addEventListener('click', () => navigatePage(1));

    // OCR
    elements.processAllBtn.addEventListener('click', processAllPages);
    elements.processPageBtn.addEventListener('click', processCurrentPage);

    // View
    elements.toggleViewBtn.addEventListener('click', toggleRawView);
    elements.copyBtn.addEventListener('click', copyToClipboard);

    // Export & Clear
    elements.downloadBtn.addEventListener('click', downloadMarkdown);
    elements.clearBtn.addEventListener('click', clearAll);

    // Keyboard
    document.addEventListener('keydown', handleKeyboard);
}

// Drag & Drop
function handleDragOver(e) {
    e.preventDefault();
    elements.dropZone.classList.add('dragover');
}

function handleDragLeave(e) {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
}

function handleDrop(e) {
    e.preventDefault();
    elements.dropZone.classList.remove('dragover');
    if (e.dataTransfer.files.length > 0) {
        handleFile(e.dataTransfer.files[0]);
    }
}

function handleFileSelect(e) {
    if (e.target.files.length > 0) {
        handleFile(e.target.files[0]);
    }
}

// Upload file
async function handleFile(file) {
    const allowed = ['.pdf', '.png', '.jpg', '.jpeg', '.tiff', '.tif', '.bmp', '.gif', '.webp'];
    const ext = '.' + file.name.split('.').pop().toLowerCase();

    if (!allowed.includes(ext)) {
        showToast('Formato non supportato', 'error');
        return;
    }

    showLoading('Caricamento documento...');
    state.filename = file.name.replace(/\.[^/.]+$/, '');

    const formData = new FormData();
    formData.append('file', file);

    try {
        const response = await fetch(`${API_BASE}/api/upload`, {
            method: 'POST',
            body: formData
        });

        if (!response.ok) {
            const err = await response.json();
            throw new Error(err.detail || 'Upload failed');
        }

        const data = await response.json();

        // Initialize state
        state.jobId = data.job_id;
        state.totalPages = data.pages;
        state.currentPage = 1;
        state.results = {};

        // Show main view
        showMainView();
        renderThumbnails();
        showPage(1);
        updateProgress();

        showToast(`Documento caricato: ${data.pages} pagine`, 'success');

    } catch (error) {
        showToast(error.message, 'error');
    } finally {
        hideLoading();
    }
}

// View Management
function showMainView() {
    elements.uploadScreen.style.display = 'none';
    elements.mainView.style.display = 'flex';
    elements.clearBtn.style.display = 'inline-flex';
    elements.processAllBtn.disabled = false;
}

function showUploadView() {
    elements.uploadScreen.style.display = 'flex';
    elements.mainView.style.display = 'none';
    elements.clearBtn.style.display = 'none';
}

// Thumbnails
function renderThumbnails() {
    elements.thumbnailsContainer.innerHTML = '';

    for (let i = 1; i <= state.totalPages; i++) {
        const thumbnail = document.createElement('div');
        thumbnail.className = `thumbnail ${state.results[i]?.status || 'pending'}`;
        thumbnail.dataset.page = i;

        const img = document.createElement('img');
        img.src = `${API_BASE}/api/page/${state.jobId}/${i}`;
        img.alt = `Pagina ${i}`;

        thumbnail.appendChild(img);
        thumbnail.addEventListener('click', () => showPage(i));

        elements.thumbnailsContainer.appendChild(thumbnail);
    }
}

// Page Navigation
function showPage(pageNum) {
    if (pageNum < 1 || pageNum > state.totalPages) return;

    state.currentPage = pageNum;

    // Update main image
    elements.currentPageImg.src = `${API_BASE}/api/page/${state.jobId}/${pageNum}`;

    // Update thumbnails
    document.querySelectorAll('.thumbnail').forEach((thumb, i) => {
        thumb.classList.toggle('active', i + 1 === pageNum);
    });

    // Update page counter
    elements.pageCounter.textContent = `Pagina ${pageNum} di ${state.totalPages}`;

    // Update navigation buttons
    elements.prevPageBtn.disabled = pageNum === 1;
    elements.nextPageBtn.disabled = pageNum === state.totalPages;

    // Update OCR display
    updateOCRDisplay(pageNum);
}

function navigatePage(direction) {
    showPage(state.currentPage + direction);
}

// OCR Display
function updateOCRDisplay(pageNum) {
    const result = state.results[pageNum];

    if (!result) {
        // No result yet
        updateOCRStatus('pending');
        elements.markdownBody.innerHTML = `<div class="empty-state">
            <svg class="empty-state-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                <circle cx="12" cy="12" r="10"></circle>
                <line x1="12" y1="8" x2="12" y2="12"></line>
                <line x1="12" y1="16" x2="12.01" y2="16"></line>
            </svg>
            <h3>Pagina non elaborata</h3>
            <p>Clicca "OCR" per elaborare questa pagina</p>
        </div>`;
        elements.processPageBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polygon points="5 3 19 12 5 21 5 3"></polygon>
            </svg>
            OCR
        `;
        elements.processPageBtn.disabled = false;
        return;
    }

    updateOCRStatus(result.status, result.error);

    if (result.status === 'completed' && result.markdown) {
        if (state.isRawView) {
            elements.markdownBody.style.display = 'none';
            elements.rawEditor.style.display = 'block';
            elements.rawEditor.value = result.markdown;
        } else {
            elements.rawEditor.style.display = 'none';
            elements.markdownBody.style.display = 'block';
            elements.markdownBody.innerHTML = marked.parse(result.markdown);
        }
        elements.downloadBtn.disabled = false;

        elements.processPageBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M23 4v6h-6"></path>
                <path d="M1 20v-6h6"></path>
                <path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path>
            </svg>
            Re-OCR
        `;
    } else if (result.status === 'error') {
        elements.markdownBody.innerHTML = `<div class="empty-state">
            <p style="color: var(--accent-red);">Errore: ${result.error}</p>
        </div>`;
    }

    elements.processPageBtn.disabled = result.status === 'processing';
}

function updateOCRStatus(status, error = '') {
    const statusEl = elements.ocrStatus;
    statusEl.className = 'ocr-status';

    switch (status) {
        case 'pending':
            statusEl.innerHTML = '<span class="status-text">In attesa</span>';
            break;
        case 'processing':
            statusEl.className += ' processing';
            statusEl.innerHTML = `
                <div class="loading-spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>
                <span class="status-text">Elaborazione in corso...</span>
            `;
            // Clear any previous content while processing
            elements.markdownBody.innerHTML = '';
            elements.rawEditor.value = '';
            break;
        case 'completed':
            statusEl.className += ' completed';
            statusEl.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <polyline points="20 6 9 17 4 12"></polyline>
                </svg>
                <span class="status-text">Completato</span>
            `;
            break;
        case 'error':
            statusEl.className += ' error';
            statusEl.innerHTML = `
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                    <circle cx="12" cy="12" r="10"></circle>
                    <line x1="15" y1="9" x2="9" y2="15"></line>
                    <line x1="9" y1="9" x2="15" y2="15"></line>
                </svg>
                <span class="status-text">Errore: ${error}</span>
            `;
            break;
    }
}

// OCR Processing with SSE Streaming
async function processPage(pageNum, forceRefresh = false) {
    const current = state.results[pageNum];
    if (current?.status === 'processing') return;

    // Set processing state
    state.results[pageNum] = { status: 'processing', markdown: '', error: '' };
    updateOCRDisplay(pageNum);
    updateThumbnailStatus(pageNum);

    try {
        const params = new URLSearchParams();
        if (forceRefresh) params.append('refresh', 'true');
        const url = `${API_BASE}/api/ocr/${state.jobId}/${pageNum}?${params.toString()}`;
        const eventSource = new EventSource(url);

        let markdown = '';

        eventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.chunk) {
                    markdown += data.chunk;
                    state.results[pageNum] = { status: 'processing', markdown, error: '' };
                    if (pageNum === state.currentPage) {
                        if (state.isRawView) {
                            elements.rawEditor.value = markdown;
                        } else {
                            elements.markdownBody.innerHTML = marked.parse(markdown);
                        }
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        };

        eventSource.addEventListener('stage', (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.stage === 'ocr') {
                    if (pageNum === state.currentPage && elements.ocrStatus) {
                        elements.ocrStatus.className = 'ocr-status processing';
                        elements.ocrStatus.innerHTML = `
                            <div class="loading-spinner" style="width: 14px; height: 14px; border-width: 2px;"></div>
                            <span class="status-text">${data.message || 'Running OCR...'}</span>
                        `;
                    }
                }
            } catch (e) {
                // Ignore parse errors
            }
        });

        eventSource.addEventListener('done', (event) => {
            eventSource.close();
            state.results[pageNum] = { status: 'completed', markdown, error: '' };
            updateOCRDisplay(pageNum);
            updateThumbnailStatus(pageNum);
            updateProgress();
        });

        eventSource.addEventListener('error', (event) => {
            eventSource.close();
            try {
                const data = JSON.parse(event.data);
                state.results[pageNum] = { status: 'error', markdown: '', error: data.error || 'Unknown error' };
            } catch (e) {
                state.results[pageNum] = { status: 'error', markdown: '', error: 'Connection error' };
            }
            updateOCRDisplay(pageNum);
            updateThumbnailStatus(pageNum);
        });

        eventSource.onerror = () => {
            eventSource.close();
            state.results[pageNum] = { status: 'error', markdown: '', error: 'Connection failed' };
            updateOCRDisplay(pageNum);
            updateThumbnailStatus(pageNum);
        };

    } catch (error) {
        state.results[pageNum] = { status: 'error', markdown: '', error: error.message };
        updateOCRDisplay(pageNum);
        updateThumbnailStatus(pageNum);
    }
}

async function processCurrentPage() {
    const current = state.results[state.currentPage];
    const forceRefresh = current?.status === 'completed';
    await processPage(state.currentPage, forceRefresh);
}

async function processAllPages() {
    if (state.isProcessing) return;

    state.isProcessing = true;
    elements.processAllBtn.disabled = true;
    elements.processAllBtn.innerHTML = `
        <div class="loading-spinner" style="width: 16px; height: 16px; border-width: 2px;"></div>
        Elaborazione...
    `;

    for (let i = 1; i <= state.totalPages; i++) {
        if (!state.results[i] || state.results[i].status !== 'completed') {
            await processPage(i);
            // Wait a bit between pages
            await new Promise(r => setTimeout(r, 500));
        }
    }

    state.isProcessing = false;
    elements.processAllBtn.disabled = false;
    elements.processAllBtn.innerHTML = `
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <polygon points="5 3 19 12 5 21 5 3"></polygon>
        </svg>
        Processa Tutto
    `;

    showToast('Elaborazione completata', 'success');
}

function updateThumbnailStatus(pageNum) {
    const thumbnails = elements.thumbnailsContainer.children;
    const thumb = thumbnails[pageNum - 1];
    if (thumb) {
        const status = state.results[pageNum]?.status || 'pending';
        thumb.className = `thumbnail ${status}`;
        if (pageNum === state.currentPage) {
            thumb.classList.add('active');
        }
    }
}

function updateProgress() {
    const completed = Object.values(state.results).filter(r => r?.status === 'completed').length;
    const percent = state.totalPages > 0 ? (completed / state.totalPages) * 100 : 0;
    elements.progressBar.style.width = `${percent}%`;
}

// View Toggle
function toggleRawView() {
    state.isRawView = !state.isRawView;
    elements.toggleViewBtn.innerHTML = state.isRawView
        ? `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
           </svg> Toggle Preview`
        : `<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"></path>
            <circle cx="12" cy="12" r="3"></circle>
           </svg> Toggle Raw`;
    updateOCRDisplay(state.currentPage);
}

// Clipboard
async function copyToClipboard() {
    const result = state.results[state.currentPage];
    if (!result?.markdown) {
        showToast('Nessun contenuto da copiare', 'error');
        return;
    }

    try {
        await navigator.clipboard.writeText(result.markdown);
        showToast('Copiato negli appunti', 'success');

        const original = elements.copyBtn.innerHTML;
        elements.copyBtn.innerHTML = `
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <polyline points="20 6 9 17 4 12"></polyline>
            </svg>
            Copiato!
        `;
        setTimeout(() => elements.copyBtn.innerHTML = original, 2000);
    } catch {
        showToast('Errore durante la copia', 'error');
    }
}

// Download
async function downloadMarkdown() {
    if (!state.jobId) return;

    try {
        const response = await fetch(`${API_BASE}/api/markdown/${state.jobId}`);
        if (!response.ok) {
            showToast('Nessun contenuto da scaricare', 'error');
            return;
        }

        const data = await response.json();
        const blob = new Blob([data.markdown], { type: 'text/markdown' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = `${state.filename || 'documento'}.md`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        URL.revokeObjectURL(url);

        showToast('Download completato', 'success');
    } catch {
        showToast('Errore durante il download', 'error');
    }
}

// Clear
async function clearAll() {
    if (state.jobId) {
        try {
            await fetch(`${API_BASE}/api/jobs/${state.jobId}`, { method: 'DELETE' });
        } catch (e) {
            // Ignore deletion errors
        }
    }

    state.jobId = null;
    state.filename = '';
    state.totalPages = 0;
    state.currentPage = 1;
    state.results = {};
    state.isProcessing = false;
    state.isRawView = false;

    elements.fileInput.value = '';
    elements.progressBar.style.width = '0%';
    elements.downloadBtn.disabled = true;

    showUploadView();
}

// Health Check
async function checkHealth() {
    try {
        const response = await fetch(`${API_BASE}/api/health`);
        const data = await response.json();

        const badge = elements.statusBadge;
        const text = badge.querySelector('.status-text');

        if (data.ollama_connected && data.ocr_model_available) {
            badge.className = 'status-badge healthy';
            text.textContent = 'Ollama (local)';
        } else if (data.ollama_connected) {
            badge.className = 'status-badge warning';
            text.textContent = 'OCR model non trovato';
        } else {
            badge.className = 'status-badge error';
            text.textContent = 'Ollama offline';
        }
    } catch {
        const badge = elements.statusBadge;
        const text = badge.querySelector('.status-text');
        badge.className = 'status-badge error';
        text.textContent = 'Backend offline';
    }
}

// Keyboard
function handleKeyboard(e) {
    if (e.key === 'Escape') {
        if (state.jobId) {
            clearAll();
            return;
        }
    }

    if (e.key === 'ArrowLeft' && !elements.prevPageBtn.disabled) {
        navigatePage(-1);
    } else if (e.key === 'ArrowRight' && !elements.nextPageBtn.disabled) {
        navigatePage(1);
    }

    if ((e.ctrlKey || e.metaKey) && e.key === 's') {
        e.preventDefault();
        if (!elements.downloadBtn.disabled) {
            downloadMarkdown();
        }
    }
}

// Loading & Toast
function showLoading(text = 'Caricamento...') {
    elements.loadingText.textContent = text;
    elements.loadingOverlay.style.display = 'flex';
}

function hideLoading() {
    elements.loadingOverlay.style.display = 'none';
}

function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `
        ${type === 'success' ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"></polyline></svg>' : ''}
        ${type === 'error' ? '<svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"></circle><line x1="15" y1="9" x2="9" y2="15"></line><line x1="9" y1="9" x2="15" y2="15"></line></svg>' : ''}
        <span>${message}</span>
    `;
    document.body.appendChild(toast);

    setTimeout(() => {
        toast.style.animation = 'slideIn 0.3s ease reverse';
        setTimeout(() => toast.remove(), 300);
    }, 3000);
}