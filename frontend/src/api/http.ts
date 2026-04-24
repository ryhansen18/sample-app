export class UnauthorizedError extends Error {
    constructor(message = 'Unauthorized') {
        super(message)
        this.name = 'UnauthorizedError'
    }
}

type AuthHooks = {
    getToken: () => string | null
    onUnauthorized: () => void
}

let getToken: () => string | null = () => null
let onUnauthorized: () => void = () => { }

export function setAuthHooks(hooks: AuthHooks): void {
    getToken = hooks.getToken
    onUnauthorized = hooks.onUnauthorized
}

async function extractErrorMessage(response: Response): Promise<string> {
    try {
        const data = await response.json()
        if (data && typeof data === 'object') {
            if (typeof (data as { detail?: unknown }).detail === 'string')
                return (data as { detail: string }).detail
            if (typeof (data as { title?: unknown }).title === 'string')
                return (data as { title: string }).title
        }
    } catch {
        // fall through
    }
    return `Request failed with status ${response.status}`
}

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
    const headers = new Headers(init?.headers)
    if (!headers.has('Content-Type')) {
        headers.set('Content-Type', 'application/json')
    }
    const token = getToken()
    if (token && !headers.has('Authorization')) {
        headers.set('Authorization', `Bearer ${token}`)
    }

    const base = import.meta.env.VITE_API_URL ?? ''
    const response = await fetch(`${base}${url}`, { ...init, headers })

    if (response.status === 401) {
        onUnauthorized()
        const message = await extractErrorMessage(response)
        throw new UnauthorizedError(message)
    }

    if (!response.ok) {
        const message = await extractErrorMessage(response)
        throw new Error(message)
    }

    if (response.status === 204) return undefined as T
    return (await response.json()) as T
}