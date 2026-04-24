import { http, HttpResponse } from 'msw'
import type { Note } from '../api/notes'

type NoteInputBody = { title?: unknown; content?: unknown }
type AuthBody = { email?: unknown; password?: unknown }

type StoredNote = Note & { ownerId: string }

export type NotesStore = {
    notes: StoredNote[]
    reset: (seed?: StoredNote[]) => void
}

function cloneNotes(notes: StoredNote[]): StoredNote[] {
    return notes.map((n) => ({ ...n }))
}

export function createNotesStore(seed: StoredNote[] = []): NotesStore {
    const store: NotesStore = {
        notes: cloneNotes(seed),
        reset(next = []) {
            store.notes = cloneNotes(next)
        },
    }
    return store
}

export type StoredUser = { id: string; email: string; password: string }

export type AuthStore = {
    users: Map<string, StoredUser>
    tokens: Map<string, string>
    reset: () => void
}

export function createAuthStore(): AuthStore {
    const store: AuthStore = {
        users: new Map(),
        tokens: new Map(),
        reset() {
            store.users.clear()
            store.tokens.clear()
        },
    }
    return store
}

export const SEED_USER_ID = 'seed-user-id'
export const SEED_USER_EMAIL = 'seed@test.local'
export const SEED_USER_PASSWORD = 'Password123!'
export const SEED_USER_TOKEN = 'seed-token'

export const defaultSeed: StoredNote[] = [
    {
        id: '11111111-1111-1111-1111-111111111111',
        title: 'Shopping list',
        content: 'Eggs, bread, milk',
        createdAt: '2026-04-01T12:00:00.000Z',
        updatedAt: '2026-04-10T08:30:00.000Z',
        ownerId: SEED_USER_ID,
    },
    {
        id: '22222222-2222-2222-2222-222222222222',
        title: 'Ideas',
        content: 'Write more tests.',
        createdAt: '2026-04-02T09:00:00.000Z',
        updatedAt: '2026-04-12T15:00:00.000Z',
        ownerId: SEED_USER_ID,
    },
]

export function seedAuthStore(authStore: AuthStore): void {
    authStore.reset()
    authStore.users.set(SEED_USER_EMAIL.toLowerCase(), {
        id: SEED_USER_ID,
        email: SEED_USER_EMAIL,
        password: SEED_USER_PASSWORD,
    })
    authStore.tokens.set(SEED_USER_TOKEN, SEED_USER_ID)
}

function currentUserId(request: Request, authStore: AuthStore): string | null {
    const header = request.headers.get('Authorization')
    if (!header) return null
    const match = /^Bearer\s+(.+)$/i.exec(header)
    if (!match) return null
    return authStore.tokens.get(match[1]) ?? null
}

type ProblemDetails = {
    type: string
    title: string
    status: number
}

function unauthorized(): HttpResponse<ProblemDetails> {
    return HttpResponse.json(
        {
            type: 'about:blank',
            title: 'Unauthorized',
            status: 401,
        },
        { status: 401 },
    )
}

function toNoteDto(note: StoredNote): Note {
    return {
        id: note.id,
        title: note.title,
        content: note.content,
        createdAt: note.createdAt,
        updatedAt: note.updatedAt,
    }
}

function mintToken(): string {
    return crypto.randomUUID()
}

function expiresAtIso(): string {
    return new Date(Date.now() + 3_600_000).toISOString()
}

export function createHandlers(
    store: NotesStore,
    authStore: AuthStore = defaultAuthStore,
) {
    return [
        http.post('/api/auth/register', async ({ request }) => {
            const body = (await request.json()) as AuthBody
            const email = typeof body.email === 'string' ? body.email.trim() : ''
            const password = typeof body.password === 'string' ? body.password : ''
            if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
                return HttpResponse.json(
                    {
                        title: 'Validation failed',
                        status: 400,
                        detail: 'Email is required.',
                        errors: { email: ['Email is required.'] },
                    },
                    { status: 400 },
                )
            }
            if (password.length < 8) {
                return HttpResponse.json(
                    {
                        title: 'Validation failed',
                        status: 400,
                        detail: 'Password must be at least 8 characters.',
                        errors: {
                            password: ['Password must be at least 8 characters.'],
                        },
                    },
                    { status: 400 },
                )
            }
            const key = email.toLowerCase()
            if (authStore.users.has(key)) {
                return HttpResponse.json(
                    {
                        title: 'Email already registered',
                        status: 400,
                        detail: 'Email already registered.',
                    },
                    { status: 400 },
                )
            }
            const user: StoredUser = { id: crypto.randomUUID(), email, password }
            authStore.users.set(key, user)
            const token = mintToken()
            authStore.tokens.set(token, user.id)
            return HttpResponse.json({
                accessToken: token,
                expiresAt: expiresAtIso(),
                user: { id: user.id, email: user.email },
            })
        }),

        http.post('/api/auth/login', async ({ request }) => {
            const body = (await request.json()) as AuthBody
            const email = typeof body.email === 'string' ? body.email.trim() : ''
            const password = typeof body.password === 'string' ? body.password : ''
            const user = authStore.users.get(email.toLowerCase())
            if (!user || user.password !== password) {
                return HttpResponse.json(
                    {
                        type: 'about:blank',
                        title: 'Invalid credentials',
                        status: 401,
                    },
                    { status: 401 },
                )
            }
            const token = mintToken()
            authStore.tokens.set(token, user.id)
            return HttpResponse.json({
                accessToken: token,
                expiresAt: expiresAtIso(),
                user: { id: user.id, email: user.email },
            })
        }),

        http.get('/api/auth/me', ({ request }) => {
            const userId = currentUserId(request, authStore)
            if (!userId) return unauthorized()
            const user = [...authStore.users.values()].find(
                (u) => u.id === userId,
            )
            if (!user) return unauthorized()
            return HttpResponse.json({ id: user.id, email: user.email })
        }),

        http.get('/api/notes', ({ request }) => {
            const userId = currentUserId(request, authStore)
            if (!userId) return unauthorized()
            const notes = store.notes
                .filter((n) => n.ownerId === userId)
                .map(toNoteDto)
            return HttpResponse.json(notes)
        }),

        http.get('/api/notes/:id', ({ params, request }) => {
            const userId = currentUserId(request, authStore)
            if (!userId) return unauthorized()
            const note = store.notes.find(
                (n) => n.id === params.id && n.ownerId === userId,
            )
            if (!note) {
                return HttpResponse.json(
                    { title: 'Not Found', status: 404, detail: 'Note not found' },
                    { status: 404 },
                )
            }
            return HttpResponse.json(toNoteDto(note))
        }),

        http.post('/api/notes', async ({ request }) => {
            const userId = currentUserId(request, authStore)
            if (!userId) return unauthorized()
            const body = (await request.json()) as NoteInputBody
            const title = typeof body.title === 'string' ? body.title : ''
            const content = typeof body.content === 'string' ? body.content : ''
            const now = new Date().toISOString()
            const note: StoredNote = {
                id: crypto.randomUUID(),
                title,
                content,
                createdAt: now,
                updatedAt: now,
                ownerId: userId,
            }
            store.notes = [...store.notes, note]
            return HttpResponse.json(toNoteDto(note), {
                status: 201,
                headers: { Location: `/api/notes/${note.id}` },
            })
        }),

        http.put('/api/notes/:id', async ({ params, request }) => {
            const userId = currentUserId(request, authStore)
            if (!userId) return unauthorized()
            const body = (await request.json()) as NoteInputBody
            const index = store.notes.findIndex(
                (n) => n.id === params.id && n.ownerId === userId,
            )
            if (index === -1) {
                return HttpResponse.json(
                    { title: 'Not Found', status: 404, detail: 'Note not found' },
                    { status: 404 },
                )
            }
            const existing = store.notes[index]
            const updated: StoredNote = {
                ...existing,
                title: typeof body.title === 'string' ? body.title : existing.title,
                content:
                    typeof body.content === 'string' ? body.content : existing.content,
                updatedAt: new Date().toISOString(),
            }
            const next = [...store.notes]
            next[index] = updated
            store.notes = next
            return HttpResponse.json(toNoteDto(updated))
        }),

        http.delete('/api/notes/:id', ({ params, request }) => {
            const userId = currentUserId(request, authStore)
            if (!userId) return unauthorized()
            const index = store.notes.findIndex(
                (n) => n.id === params.id && n.ownerId === userId,
            )
            if (index === -1) {
                return HttpResponse.json(
                    { title: 'Not Found', status: 404, detail: 'Note not found' },
                    { status: 404 },
                )
            }
            store.notes = store.notes.filter((n) => n.id !== params.id)
            return new HttpResponse(null, { status: 204 })
        }),
    ]
}

export const notesStore = createNotesStore()
export const defaultAuthStore = createAuthStore()
export const handlers = createHandlers(notesStore, defaultAuthStore)
