import { triggerDownload } from './download-utils';

/**
 * A single entry to be included in a ZIP archive or written directly to a folder.
 */
export interface WriterEntry {
    name: string;
    lastModified: Date;
    input: Blob | string | ArrayBuffer | Uint8Array;
}

/** Minimal interface for the Neutralino bridge used by ZipNeutralinoWriter */
interface NeutralinoBridge {
    os: {
        showSaveDialog(
            title: string,
            options: { defaultPath: string; filters: Array<{ name: string; extensions: string[] }> }
        ): Promise<string | null>;
        showFolderDialog(title: string, options?: Record<string, unknown>): Promise<string | null>;
    };
    filesystem: {
        writeBinaryFile(path: string, buffer: ArrayBuffer): Promise<void>;
        appendBinaryFile(path: string, buffer: ArrayBuffer): Promise<void>;
        createDirectory(path: string): Promise<void>;
    };
}

async function loadClientZip() {
    try {
        return await import('client-zip');
    } catch (error) {
        console.error('Failed to load client-zip:', error);
        throw new Error('Failed to load ZIP library');
    }
}

/**
 * Interface for writing a collection of file entries to an output destination.
 * Each implementation handles its own output selection (save dialog, directory picker, etc.)
 * and throws a DOMException with name 'AbortError' if the user cancels.
 */
export interface IBulkDownloadWriter {
    write(files: AsyncIterable<WriterEntry>): Promise<void>;
}

/**
 * Writes files through the htmlOS Files API into a target base folder
 * (defaults to `Downloads`).
 */
export class HtmlOSDownloadsWriter implements IBulkDownloadWriter {
    constructor(private readonly basePath: string = 'Downloads') {}

    private async ensureDirectory(
        createFolder: ((path: string) => Promise<void>) | undefined,
        dirPath: string,
        createdDirs: Set<string>
    ): Promise<void> {
        if (!createFolder || !dirPath) return;

        const parts = dirPath.split('/').filter(Boolean);
        let current = '';

        for (const part of parts) {
            current = current ? `${current}/${part}` : part;
            if (createdDirs.has(current)) continue;
            try {
                await createFolder(current);
            } catch {
                // Directory may already exist; ignore.
            }
            createdDirs.add(current);
        }
    }

    private toFile(input: WriterEntry['input'], filename: string, lastModified: Date): File {
        if (input instanceof Blob) {
            return new File([input], filename, {
                type: input.type || 'application/octet-stream',
                lastModified: lastModified.getTime(),
            });
        }

        if (typeof input === 'string') {
            return new File([input], filename, {
                type: 'text/plain',
                lastModified: lastModified.getTime(),
            });
        }

        const buffer =
            input instanceof Uint8Array
                ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
                : input;

        return new File([buffer], filename, {
            type: 'application/octet-stream',
            lastModified: lastModified.getTime(),
        });
    }

    async write(files: AsyncIterable<WriterEntry>): Promise<void> {
        const htmlosApi = (await import('@htmlos-next/api')) as {
            createFolder?: (path: string) => Promise<void>;
            uploadFile?: (path: string, file: File, onProgress?: (progress: number) => void) => Promise<unknown>;
        };

        if (typeof htmlosApi.uploadFile !== 'function') {
            throw new Error('htmlOS upload API is not available');
        }

        const createdDirs = new Set<string>();
        await this.ensureDirectory(htmlosApi.createFolder, this.basePath, createdDirs);

        for await (const file of files) {
            const pathParts = file.name.split('/').filter(Boolean);
            if (pathParts.length === 0) continue;

            const filename = pathParts[pathParts.length - 1];
            const relativeDir = pathParts.slice(0, -1).join('/');
            const targetDir = relativeDir ? `${this.basePath}/${relativeDir}` : this.basePath;

            await this.ensureDirectory(htmlosApi.createFolder, targetDir, createdDirs);

            const uploadable = this.toFile(file.input, filename, file.lastModified);
            await htmlosApi.uploadFile(targetDir, uploadable);
        }
    }
}

/**
 * Triggers individual downloads for each file entry, one after another.
 */
export class SequentialFileWriter implements IBulkDownloadWriter {
    constructor() {}

    async write(files: AsyncIterable<WriterEntry>): Promise<void> {
        for await (const file of files) {
            const name = file.name?.split('/').pop();
            const ext = name?.split('.').pop().toLowerCase();

            if (!name) {
                console.warn('No name for file entry.', file);
                continue;
            }

            if (['m3u', 'm3u8', 'cue', 'jpg', 'png', 'nfo', 'json'].includes(ext)) {
                continue;
            }

            if (file.input instanceof Blob) {
                triggerDownload(file.input, name);
            } else {
                triggerDownload(new Blob([file.input as BlobPart]), name);
            }
        }
    }
}

/**
 * Streams a ZIP archive to a file via the File System Access API.
 * Prompts the user to choose a save location with showSaveFilePicker.
 */
export class ZipStreamWriter implements IBulkDownloadWriter {
    constructor(private readonly suggestedFilename: string) {}

    async write(files: AsyncIterable<WriterEntry>): Promise<void> {
        // showSaveFilePicker is part of the File System Access API (not yet in all TS DOM libs)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        const fileHandle = await (window as any).showSaveFilePicker({
            suggestedName: this.suggestedFilename,
            types: [{ description: 'ZIP Archive', accept: { 'application/zip': ['.zip'] } }],
        });
        const { downloadZip } = await loadClientZip();
        const writable = await fileHandle.createWritable();
        const response = downloadZip(files);
        if (!response.body) throw new Error('ZIP response body is null');
        await response.body.pipeTo(writable);
    }
}

/**
 * Collects a ZIP archive into a Blob and triggers a browser download.
 * Works on all browsers without requiring the File System Access API.
 */
export class ZipBlobWriter implements IBulkDownloadWriter {
    constructor(private readonly filename: string) {}

    async write(files: AsyncIterable<WriterEntry>): Promise<void> {
        const { downloadZip } = await loadClientZip();
        const response = downloadZip(files);
        const blob = await response.blob();
        triggerDownload(blob, this.filename);
    }
}

/**
 * Writes a ZIP archive to the filesystem via the Neutralino desktop bridge,
 * showing a native save dialog first.
 */
export class ZipNeutralinoWriter implements IBulkDownloadWriter {
    constructor(private readonly folderName: string) {}

    async write(files: AsyncIterable<WriterEntry>): Promise<void> {
        const bridge = (await import('./desktop/neutralino-bridge.js')) as unknown as NeutralinoBridge;

        const savePath = await bridge.os.showSaveDialog(`Select save location for ${this.folderName}.zip`, {
            defaultPath: `${this.folderName}.zip`,
            filters: [{ name: 'ZIP Archive', extensions: ['zip'] }],
        });

        if (!savePath) {
            throw new DOMException('User cancelled save dialog', 'AbortError');
        }

        const { downloadZip } = await loadClientZip();
        const response = downloadZip(files);
        if (!response.body) throw new Error('ZIP response body is null');

        await bridge.filesystem.writeBinaryFile(savePath, new ArrayBuffer(0));

        const reader = response.body.getReader();
        let receivedLength = 0;

        for await (const value of readableStreamIterator(response.body)) {
            const chunk = value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
            await bridge.filesystem.appendBinaryFile(savePath, chunk);
            receivedLength += value.length;
        }

        console.log(`[ZIP] Download complete. Total size: ${receivedLength} bytes.`);
    }
}

/**
 * Writes files directly into a user-chosen folder using the standard browser
 * File System Access API (showDirectoryPicker). Subdirectories embedded in
 * file entry names are created automatically.
 *
 * Use the static {@link FolderPickerWriter.create} method to obtain an instance;
 * the constructor is private so the directory handle is always set before use.
 */
export class FolderPickerWriter implements IBulkDownloadWriter {
    private constructor(private readonly dirHandle: FileSystemDirectoryHandle) {}

    /** Returns the underlying directory handle (e.g. to persist it for later re-use). */
    getDirHandle(): FileSystemDirectoryHandle {
        return this.dirHandle;
    }

    /**
     * Creates a {@link FolderPickerWriter} from an already-obtained handle
     * without showing a directory picker.  Useful when re-using a stored handle
     * whose permission has already been verified by the caller.
     */
    static fromHandle(handle: FileSystemDirectoryHandle): FolderPickerWriter {
        return new FolderPickerWriter(handle);
    }

    /**
     * Prompts the user to pick a writable directory, or re-uses a previously
     * saved handle when one is supplied and write permission can be obtained.
     * Returns a new {@link FolderPickerWriter} bound to the chosen directory.
     * If the user dismisses the picker, the promise rejects with a DOMException
     * whose name is "AbortError".
     */
    static async create(savedHandle?: FileSystemDirectoryHandle | null): Promise<FolderPickerWriter> {
        // Try to re-use a saved handle first
        if (savedHandle) {
            try {
                // eslint-disable-next-line @typescript-eslint/no-explicit-any
                const permission = await (savedHandle as any).requestPermission({ mode: 'readwrite' });
                if (permission === 'granted') {
                    return new FolderPickerWriter(savedHandle);
                }
            } catch {
                // Fall through to show the picker
            }
        }

        // showDirectoryPicker is part of the File System Access API (not yet in all TS DOM libs)
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        try {
            const dirHandle: FileSystemDirectoryHandle = await (window as any).showDirectoryPicker({
                mode: 'readwrite',
            });
            return new FolderPickerWriter(dirHandle);
        } catch (error) {
            if (error instanceof DOMException && error.name === 'AbortError') {
                throw error;
            }
            throw new DOMException('User cancelled directory picker', 'AbortError');
        }
    }

    async write(files: AsyncIterable<WriterEntry>): Promise<void> {
        for await (const file of files) {
            const parts = file.name.split('/').filter(Boolean);
            if (parts.length === 0) continue;

            let currentDir: FileSystemDirectoryHandle = this.dirHandle;
            for (let i = 0; i < parts.length - 1; i++) {
                currentDir = await currentDir.getDirectoryHandle(parts[i], { create: true });
            }

            const filename = parts[parts.length - 1];
            const fileHandle = await currentDir.getFileHandle(filename, { create: true });
            const writable = await fileHandle.createWritable();

            try {
                const { input } = file;
                if (input instanceof Blob) {
                    await writable.write(input);
                } else if (typeof input === 'string') {
                    await writable.write(new Blob([input], { type: 'text/plain' }));
                } else {
                    const buf =
                        input instanceof Uint8Array
                            ? input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength)
                            : input;
                    await writable.write(new Blob([buf as ArrayBuffer]));
                }

                await writable.close();
            } catch (error) {
                await writable.abort();
                throw error;
            }
        }
    }
}

/**
 * Writes files directly into a folder on the local filesystem via the
 * Neutralino desktop bridge.  Subdirectories are created automatically.
 */
export class NeutralinoFolderWriter implements IBulkDownloadWriter {
    constructor(private readonly basePath: string) {}

    async write(files: AsyncIterable<WriterEntry>): Promise<void> {
        // Import once per write() call; the module system caches the result.
        const bridge = (await import('./desktop/neutralino-bridge.js')) as unknown as NeutralinoBridge;
        const createdDirs = new Set<string>();

        for await (const file of files) {
            const parts = file.name.split('/').filter(Boolean);
            if (parts.length === 0) continue;

            // Ensure all parent directories exist
            for (let i = 1; i < parts.length; i++) {
                const dirPath = this.basePath + '/' + parts.slice(0, i).join('/');
                if (!createdDirs.has(dirPath)) {
                    try {
                        await bridge.filesystem.createDirectory(dirPath);
                    } catch {
                        // Directory may already exist; ignore
                    }
                    createdDirs.add(dirPath);
                }
            }

            const filePath = this.basePath + '/' + file.name;
            let buffer: ArrayBuffer;
            const { input } = file;
            if (input instanceof Blob) {
                buffer = await input.arrayBuffer();
            } else if (typeof input === 'string') {
                const encoded = new TextEncoder().encode(input);
                buffer = encoded.buffer.slice(
                    encoded.byteOffset,
                    encoded.byteOffset + encoded.byteLength
                ) as ArrayBuffer;
            } else if (input instanceof Uint8Array) {
                buffer = input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
            } else {
                buffer = input;
            }

            await bridge.filesystem.writeBinaryFile(filePath, buffer);
        }
    }
}
