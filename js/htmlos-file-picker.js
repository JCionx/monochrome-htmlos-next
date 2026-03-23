function getFileNameFromUrl(url, fallback = 'selected-file') {
    try {
        const parsed = new URL(url, window.location.href);
        const segments = parsed.pathname.split('/').filter(Boolean);
        const last = segments[segments.length - 1];
        if (!last) return fallback;
        return decodeURIComponent(last);
    } catch {
        return fallback;
    }
}

export function isHtmlOsEmbedded() {
    if (typeof window === 'undefined') return false;

    const isEmbedded = window.parent !== window;
    const isNeutralino =
        window.NL_MODE || window.location.search.includes('mode=neutralino') || window.location.search.includes('nl_port=');

    return isEmbedded && !isNeutralino;
}

export async function pickFileFromHtmlOs(extensions = []) {
    if (!isHtmlOsEmbedded()) return null;

    try {
        const htmlosApi = await import('@htmlos-next/api');
        if (typeof htmlosApi.selectFile !== 'function') return null;

        const selected = await htmlosApi.selectFile(extensions);
        if (!selected) return null;

        const fileUrl =
            typeof selected === 'string'
                ? selected
                : typeof selected?.url === 'string'
                  ? selected.url
                  : typeof selected?.fileInputUrl === 'string'
                    ? selected.fileInputUrl
                    : null;

        if (!fileUrl) return null;

        const response = await fetch(fileUrl);
        if (!response.ok) {
            throw new Error(`Failed to read selected file: ${response.status}`);
        }

        const blob = await response.blob();
        const fallbackName =
            Array.isArray(extensions) && extensions.length > 0
                ? `selected-file.${String(extensions[0]).replace(/^\./, '')}`
                : 'selected-file';
        const fileName =
            typeof selected?.name === 'string' && selected.name.trim()
                ? selected.name.trim()
                : getFileNameFromUrl(fileUrl, fallbackName);

        return new File([blob], fileName, {
            type: blob.type || 'application/octet-stream',
            lastModified: Date.now(),
        });
    } catch (error) {
        console.warn('htmlOS file selection failed:', error);
        return null;
    }
}

export function getPickedFile(inputEl) {
    if (!inputEl) return null;
    return inputEl.__htmlosSelectedFile || inputEl.files?.[0] || null;
}

export function clearPickedFile(inputEl) {
    if (!inputEl) return;
    delete inputEl.__htmlosSelectedFile;
    delete inputEl.dataset.selectedFileName;
    inputEl.value = '';
}

export function installHtmlOsFileInputBridge(inputEl, extensions = []) {
    if (!inputEl || !isHtmlOsEmbedded()) return;

    inputEl.addEventListener('click', async (event) => {
        event.preventDefault();
        event.stopPropagation();

        const file = await pickFileFromHtmlOs(extensions);
        if (!file) return;

        inputEl.__htmlosSelectedFile = file;
        inputEl.dataset.selectedFileName = file.name;
        inputEl.dispatchEvent(new Event('change', { bubbles: true }));
    });
}
