import { Client, Account } from 'appwrite';

function normalizeAppwriteEndpoint(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;

    const trimmed = rawValue.trim();
    if (!trimmed) return null;

    // Only allow absolute HTTP(S) endpoints so SDK never falls back to relative /account calls.
    if (!/^https?:\/\//i.test(trimmed)) return null;

    try {
        const url = new URL(trimmed);
        let path = url.pathname.replace(/\/+$/, '');
        if (!path.endsWith('/v1')) {
            path = `${path}/v1`.replace(/\/+/g, '/');
        }
        url.pathname = path;
        return url.toString().replace(/\/+$/, '');
    } catch {
        return null;
    }
}

function normalizeProjectId(rawValue) {
    if (!rawValue || typeof rawValue !== 'string') return null;
    const trimmed = rawValue.trim();
    return trimmed && trimmed !== 'null' && trimmed !== 'undefined' ? trimmed : null;
}

const getEndpoint = () => {
    const local = normalizeAppwriteEndpoint(localStorage.getItem('monochrome-appwrite-endpoint'));
    if (local) return local;

    const envEndpoint = normalizeAppwriteEndpoint(window.__APPWRITE_ENDPOINT__);
    if (envEndpoint) return envEndpoint;

    const hostname = window.location.hostname;
    if (hostname.endsWith('monochrome.tf') || hostname === 'monochrome.tf') {
        return 'https://auth.monochrome.tf/v1';
    }
    return 'https://auth.samidy.com/v1';
};

const getProject = () => {
    const local = normalizeProjectId(localStorage.getItem('monochrome-appwrite-project'));
    if (local) return local;

    const envProject = normalizeProjectId(window.__APPWRITE_PROJECT_ID__);
    if (envProject) return envProject;

    return 'auth-for-monochrome';
};

const resolvedEndpoint = getEndpoint();
const resolvedProject = getProject();

const client = new Client().setEndpoint(resolvedEndpoint).setProject(resolvedProject);

const account = new Account(client);
export { client, account as auth };
