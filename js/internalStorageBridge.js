import { loadInternalFileAsText, saveInternalFile } from '@htmlos-next/api';

const LOCAL_STORAGE_FILE = 'monochrome-local-storage.json';
const COOKIE_STORAGE_FILE = 'monochrome-cookie-storage.json';
const IO_TIMEOUT_MS = 1200;
const FLUSH_DEBOUNCE_MS = 150;

function withTimeout(promise, fallbackValue, timeoutMs = IO_TIMEOUT_MS) {
    return Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => resolve(fallbackValue), timeoutMs)),
    ]).catch(() => fallbackValue);
}

function safeParseObject(value) {
    if (!value) return null;
    try {
        const parsed = JSON.parse(value);
        return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : null;
    } catch {
        return null;
    }
}

function loadNativeLocalStorageSnapshot() {
    const snapshot = {};

    try {
        const ls = window.localStorage;
        for (let i = 0; i < ls.length; i += 1) {
            const key = ls.key(i);
            if (key == null) continue;
            const value = ls.getItem(key);
            if (value != null) snapshot[key] = value;
        }
    } catch {
        // ignore
    }

    return snapshot;
}

function serializeCookies(cookieMap) {
    return Object.entries(cookieMap)
        .map(([name, value]) => `${name}=${value}`)
        .join('; ');
}

function parseCookieStoreLine(line) {
    const index = line.indexOf('=');
    if (index <= 0) return null;

    const name = line.slice(0, index).trim();
    const value = line.slice(index + 1).trim();
    if (!name) return null;

    return { name, value };
}

function parseCookieSetString(setString) {
    const parts = String(setString)
        .split(';')
        .map((x) => x.trim())
        .filter(Boolean);

    if (parts.length === 0) return null;

    const first = parseCookieStoreLine(parts[0]);
    if (!first) return null;

    const attrs = {};
    for (let i = 1; i < parts.length; i += 1) {
        const entry = parseCookieStoreLine(parts[i]);
        if (!entry) {
            attrs[parts[i].toLowerCase()] = true;
            continue;
        }
        attrs[entry.name.toLowerCase()] = entry.value;
    }

    return {
        name: first.name,
        value: first.value,
        attrs,
    };
}

function cookieIsDeletion(attrs) {
    if (!attrs) return false;

    if (attrs['max-age'] === '0') return true;

    if (attrs.expires) {
        const time = Date.parse(attrs.expires);
        if (!Number.isNaN(time) && time <= Date.now()) return true;
    }

    return false;
}

export async function initializeInternalPersistenceBridge() {
    if (typeof window === 'undefined') return;

    const nativeLocalStorageSnapshot = loadNativeLocalStorageSnapshot();

    const fileLocalStorageRaw = await withTimeout(loadInternalFileAsText(LOCAL_STORAGE_FILE), undefined);
    const fileCookieRaw = await withTimeout(loadInternalFileAsText(COOKIE_STORAGE_FILE), undefined);

    const localStorageData = safeParseObject(fileLocalStorageRaw) || nativeLocalStorageSnapshot;
    const cookieData = safeParseObject(fileCookieRaw) || {};

    const localStorageMap = new Map(Object.entries(localStorageData));
    const cookieMap = { ...cookieData };

    let localStorageFlushTimer = null;
    let cookieFlushTimer = null;

    const flushLocalStorage = async () => {
        const payload = Object.fromEntries(localStorageMap);
        await withTimeout(saveInternalFile(LOCAL_STORAGE_FILE, JSON.stringify(payload)), false);
    };

    const flushCookies = async () => {
        await withTimeout(saveInternalFile(COOKIE_STORAGE_FILE, JSON.stringify(cookieMap)), false);
    };

    const scheduleLocalStorageFlush = () => {
        if (localStorageFlushTimer) clearTimeout(localStorageFlushTimer);
        localStorageFlushTimer = setTimeout(() => {
            localStorageFlushTimer = null;
            void flushLocalStorage();
        }, FLUSH_DEBOUNCE_MS);
    };

    const scheduleCookieFlush = () => {
        if (cookieFlushTimer) clearTimeout(cookieFlushTimer);
        cookieFlushTimer = setTimeout(() => {
            cookieFlushTimer = null;
            void flushCookies();
        }, FLUSH_DEBOUNCE_MS);
    };

    try {
        const localStorageProto = Object.getPrototypeOf(window.localStorage);
        const original = {
            getItem: localStorageProto.getItem,
            setItem: localStorageProto.setItem,
            removeItem: localStorageProto.removeItem,
            clear: localStorageProto.clear,
            key: localStorageProto.key,
            lengthDescriptor: Object.getOwnPropertyDescriptor(localStorageProto, 'length'),
        };

        const isLocalStorage = (ctx) => {
            try {
                return ctx === window.localStorage;
            } catch {
                return false;
            }
        };

        localStorageProto.getItem = function getItemPatched(key) {
            if (!isLocalStorage(this)) return original.getItem.call(this, key);
            const normalized = String(key);
            return localStorageMap.has(normalized) ? localStorageMap.get(normalized) : null;
        };

        localStorageProto.setItem = function setItemPatched(key, value) {
            if (!isLocalStorage(this)) return original.setItem.call(this, key, value);
            localStorageMap.set(String(key), String(value));
            scheduleLocalStorageFlush();
        };

        localStorageProto.removeItem = function removeItemPatched(key) {
            if (!isLocalStorage(this)) return original.removeItem.call(this, key);
            localStorageMap.delete(String(key));
            scheduleLocalStorageFlush();
        };

        localStorageProto.clear = function clearPatched() {
            if (!isLocalStorage(this)) return original.clear.call(this);
            localStorageMap.clear();
            scheduleLocalStorageFlush();
        };

        localStorageProto.key = function keyPatched(index) {
            if (!isLocalStorage(this)) return original.key.call(this, index);
            const keys = Array.from(localStorageMap.keys());
            return keys[index] ?? null;
        };

        if (original.lengthDescriptor && original.lengthDescriptor.configurable) {
            Object.defineProperty(localStorageProto, 'length', {
                configurable: true,
                enumerable: true,
                get() {
                    if (!isLocalStorage(this)) return original.lengthDescriptor.get?.call(this) ?? 0;
                    return localStorageMap.size;
                },
            });
        }
    } catch {
        // Ignore localStorage patch failures and allow normal app startup.
    }

    try {
        const docProto = Object.getPrototypeOf(document);
        const cookieDescriptor =
            Object.getOwnPropertyDescriptor(docProto, 'cookie') || Object.getOwnPropertyDescriptor(Document.prototype, 'cookie');

        if (cookieDescriptor?.configurable) {
            Object.defineProperty(docProto, 'cookie', {
                configurable: true,
                enumerable: true,
                get() {
                    return serializeCookies(cookieMap);
                },
                set(value) {
                    const parsed = parseCookieSetString(value);
                    if (!parsed) return true;

                    if (cookieIsDeletion(parsed.attrs)) {
                        delete cookieMap[parsed.name];
                    } else {
                        cookieMap[parsed.name] = parsed.value;
                    }

                    scheduleCookieFlush();
                    return true;
                },
            });
        }
    } catch {
        // ignore cookie patch failures
    }

    if (!safeParseObject(fileLocalStorageRaw) && Object.keys(nativeLocalStorageSnapshot).length > 0) {
        scheduleLocalStorageFlush();
    }

    if (!safeParseObject(fileCookieRaw) && Object.keys(cookieMap).length > 0) {
        scheduleCookieFlush();
    }
}
