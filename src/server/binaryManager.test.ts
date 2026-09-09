import { describe, it, expect, vi, afterEach } from 'vitest';
import { BinaryManager, downloadBuffer } from './binaryManager';
import { getAssetFilename } from './platform';

type CtorArg = ConstructorParameters<typeof BinaryManager>[0];

function makeManager(): BinaryManager {
    return new BinaryManager({ globalStorageUri: { fsPath: '/tmp/binary-manager-test' } } as CtorArg);
}

function textResponse(body: string, status = 200): Response {
    return new Response(body, { status });
}

function jsonResponse(body: unknown, status = 200): Response {
    return new Response(JSON.stringify(body), {
        status,
        headers: { 'content-type': 'application/json' },
    });
}

function abortError(): Error {
    return Object.assign(new Error('This operation was aborted'), { name: 'AbortError' });
}

/** A fetch that only settles when its AbortSignal fires (simulates a hung connection). */
function hungFetch(): ReturnType<typeof vi.fn> {
    return vi.fn((_url: string, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
            init?.signal?.addEventListener('abort', () => reject(abortError()));
        })
    );
}

describe('BinaryManager.latestVersion', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('returns the build number from the latest release\'s nightly-tag.txt', async () => {
        const fetchMock = vi.fn().mockResolvedValue(textResponse('b10809\n'));
        vi.stubGlobal('fetch', fetchMock);

        expect(await makeManager().latestVersion()).toBe('10809');
        expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('falls back to the newest bNNNN release containing this platform\'s asset', async () => {
        const expectedAsset = getAssetFilename('10809');
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(textResponse('asset gone', 404))
            .mockResolvedValueOnce(jsonResponse([
                { tag_name: 'b10999', assets: [] }, // published, asset uploads still in flight
                { tag_name: 'v0.4.0', assets: [{ name: 'nightly-tag.txt' }] },
                { tag_name: 'b10809', assets: [{ name: 'llama-b10809-ui.tar.gz' }, { name: expectedAsset }] },
            ]));
        vi.stubGlobal('fetch', fetchMock);

        expect(await makeManager().latestVersion()).toBe('10809');
    });

    it('skips bNNNN tags whose asset for this platform is missing', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(textResponse('missing', 404))
            .mockResolvedValueOnce(jsonResponse([
                { tag_name: 'b10810', assets: [{ name: 'llama-b10810-bin-something-else.tar.gz' }] },
            ]));
        vi.stubGlobal('fetch', fetchMock);

        expect(await makeManager().latestVersion()).toBeNull();
    });

    it('never returns a non-build tag (e.g. stable v0.4.0)', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(textResponse('missing', 404))
            .mockResolvedValueOnce(jsonResponse([
                { tag_name: 'v0.4.0', assets: [{ name: getAssetFilename('v0.4.0') }] },
            ]));
        vi.stubGlobal('fetch', fetchMock);

        expect(await makeManager().latestVersion()).toBeNull();
    });

    it('returns null when the tag file is unreadable and the releases API fails', async () => {
        const fetchMock = vi.fn()
            .mockResolvedValueOnce(textResponse('missing', 404))
            .mockRejectedValueOnce(new Error('fetch failed'));
        vi.stubGlobal('fetch', fetchMock);

        expect(await makeManager().latestVersion()).toBeNull();
    });

    it('returns null when the network fails on the first call', async () => {
        vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('fetch failed')));

        expect(await makeManager().latestVersion()).toBeNull();
    });
});

describe('downloadBuffer', () => {
    afterEach(() => {
        vi.unstubAllGlobals();
    });

    it('resolves with the full body', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('hello '));
                controller.enqueue(new TextEncoder().encode('world'));
                controller.close();
            },
        });
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response(stream)));

        const buffer = await downloadBuffer('https://example.com/archive.tar.gz');
        expect(buffer.toString('utf-8')).toBe('hello world');
    });

    it('throws an HTTP error containing the URL', async () => {
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('nope', { status: 404 })));

        await expect(downloadBuffer('https://example.com/missing.tar.gz')).rejects.toThrow(
            'Download failed: HTTP 404 for https://example.com/missing.tar.gz'
        );
    });

    it('aborts when the server never responds (header timeout)', async () => {
        vi.stubGlobal('fetch', hungFetch());

        await expect(
            downloadBuffer('https://example.com/archive.tar.gz', { headerTimeoutMs: 50 })
        ).rejects.toThrow(/did not respond/);
    });

    it('aborts when the body stalls mid-transfer (stall watchdog)', async () => {
        // The first read never resolves on its own; it only settles on abort,
        // mirroring real fetch behavior when the request is aborted.
        vi.stubGlobal('fetch', vi.fn((_url: string, init?: { signal?: AbortSignal }) => {
            const signal = init?.signal!;
            const fakeReader = {
                read: () =>
                    new Promise<never>((_resolve, reject) => {
                        signal.addEventListener('abort', () => reject(abortError()));
                    }),
                cancel: async () => { /* no-op */ },
            };
            return Promise.resolve({
                ok: true,
                status: 200,
                headers: new Headers(),
                body: { getReader: () => fakeReader },
            } as unknown as Response);
        }));

        await expect(
            downloadBuffer('https://example.com/archive.tar.gz', { stallTimeoutMs: 50 })
        ).rejects.toThrow(/Download stalled/);
    });

    it('reports progress when content-length is known', async () => {
        const stream = new ReadableStream<Uint8Array>({
            start(controller) {
                controller.enqueue(new TextEncoder().encode('hello '));
                controller.enqueue(new TextEncoder().encode('world'));
                controller.close();
            },
        });
        const headers = new Headers();
        headers.set('content-length', '11');
        // Plain object so the content-length header is deterministic across runtimes.
        vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
            ok: true,
            status: 200,
            headers,
            body: stream,
        } as unknown as Response));

        const percents: number[] = [];
        const buffer = await downloadBuffer('https://example.com/archive.tar.gz', {
            onProgress: percent => percents.push(percent),
        });

        expect(buffer.toString('utf-8')).toBe('hello world');
        expect(percents.length).toBeGreaterThan(0);
        expect(percents[percents.length - 1]).toBe(100);
    });
});
