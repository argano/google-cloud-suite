import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "events";

const EMULATOR = process.env.GCS_EMULATOR_HOST || "http://localhost:4443";

vi.mock("@google-cloud/storage", async () => {
    const actual = await vi.importActual<typeof import("@google-cloud/storage")>("@google-cloud/storage");
    return {
        ...actual,
        Storage: class extends actual.Storage {
            constructor(opts: ConstructorParameters<typeof actual.Storage>[0] = {}) {
                super({ projectId: "test", apiEndpoint: EMULATOR, ...opts });
            }
        },
    };
});

import { Storage } from "@google-cloud/storage";
import { handle } from "../src";

const BUCKET = "test-storage-upload";
const storage = new Storage();

async function ensureBucket() {
    const [exists] = await storage.bucket(BUCKET).exists();
    if (!exists) {
        await storage.createBucket(BUCKET);
    }
}

async function clearBucket() {
    const [files] = await storage.bucket(BUCKET).getFiles();
    await Promise.all(files.map((f) => f.delete().catch(() => undefined)));
}

function buildMultipart(parts: Array<{ name: string; value?: string; filename?: string; contentType?: string; data?: Buffer }>): { boundary: string; body: Buffer } {
    const boundary = "----vitestBoundary" + Math.random().toString(36).slice(2);
    const chunks: Buffer[] = [];
    for (const p of parts) {
        chunks.push(Buffer.from(`--${boundary}\r\n`));
        if (p.filename !== undefined) {
            chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"; filename="${p.filename}"\r\n`));
            chunks.push(Buffer.from(`Content-Type: ${p.contentType || "application/octet-stream"}\r\n\r\n`));
            chunks.push(p.data || Buffer.alloc(0));
            chunks.push(Buffer.from("\r\n"));
        } else {
            chunks.push(Buffer.from(`Content-Disposition: form-data; name="${p.name}"\r\n\r\n`));
            chunks.push(Buffer.from(p.value ?? ""));
            chunks.push(Buffer.from("\r\n"));
        }
    }
    chunks.push(Buffer.from(`--${boundary}--\r\n`));
    return { boundary, body: Buffer.concat(chunks) };
}

function mockResponse() {
    const headers: Record<string, string> = {};
    let statusCode = 200;
    let bodyJson: any;
    const done = new Promise<{ status: number; body: any; headers: Record<string, string> }>((resolve) => {
        const res: any = {
            header(k: string, v: string) {
                headers[k] = v;
                return res;
            },
            set(k: string, v: string) {
                headers[k] = v;
                return res;
            },
            status(code: number) {
                statusCode = code;
                return res;
            },
            json(b: any) {
                bodyJson = b;
                resolve({ status: statusCode, body: bodyJson, headers });
                return res;
            },
            send(b: any) {
                bodyJson = b;
                resolve({ status: statusCode, body: bodyJson, headers });
                return res;
            },
        };
        res._resolve = resolve;
        return res;
    });
    const res: any = {
        header(k: string, v: string) {
            headers[k] = v;
            return res;
        },
        set(k: string, v: string) {
            headers[k] = v;
            return res;
        },
        status(code: number) {
            statusCode = code;
            return res;
        },
        json(b: any) {
            bodyJson = b;
            (done as any)._resolve?.({ status: statusCode, body: bodyJson, headers });
            return res;
        },
        send(b: any) {
            bodyJson = b;
            (done as any)._resolve?.({ status: statusCode, body: bodyJson, headers });
            return res;
        },
    };
    // wire the resolver
    let resolver: ((v: any) => void) | undefined;
    const finished = new Promise<{ status: number; body: any; headers: Record<string, string> }>((r) => {
        resolver = r;
    });
    res.json = (b: any) => {
        bodyJson = b;
        resolver?.({ status: statusCode, body: bodyJson, headers });
        return res;
    };
    res.send = (b: any) => {
        bodyJson = b;
        resolver?.({ status: statusCode, body: bodyJson, headers });
        return res;
    };
    return { res, finished };
}

describe("handle (storage-upload)", () => {
    beforeAll(async () => {
        await ensureBucket();
        await clearBucket();
    });
    afterAll(async () => {
        await clearBucket();
    });
    beforeEach(async () => {
        await clearBucket();
    });

    it("uploads via multipart/form-data and returns 200 with key", async () => {
        const handler = handle({ bucketName: BUCKET });
        const { boundary, body } = buildMultipart([
            { name: "file", filename: "hello.txt", contentType: "text/plain", data: Buffer.from("hello world") },
        ]);
        const req: any = Object.assign(new EventEmitter(), {
            method: "POST",
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
            rawBody: body,
            get(h: string) {
                return req.headers[h.toLowerCase()];
            },
            unpipe() {
                // no-op
            },
        });
        const { res, finished } = mockResponse();

        await handler(req, res);
        const result = await finished;

        expect(result.status).toBe(200);
        expect(result.body.message).toBe("success");
        expect(result.body.key).toMatch(/\.txt$/);

        const [buf] = await storage.bucket(BUCKET).file(result.body.key).download();
        expect(buf.toString()).toBe("hello world");
    });

    it("rejects multipart upload with wrong secret", async () => {
        const handler = handle({ bucketName: BUCKET, clientSecret: "correct" });
        const { boundary, body } = buildMultipart([
            { name: "secret", value: "wrong" },
            { name: "file", filename: "x.txt", contentType: "text/plain", data: Buffer.from("nope") },
        ]);
        const req: any = Object.assign(new EventEmitter(), {
            method: "POST",
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
            rawBody: body,
            get(h: string) {
                return req.headers[h.toLowerCase()];
            },
            unpipe() {
                // no-op
            },
        });
        const { res, finished } = mockResponse();
        await handler(req, res);
        const result = await finished;
        expect(result.status).toBe(400);
    });

    it("uploads via JSON body (base64 data)", async () => {
        const handler = handle({ bucketName: BUCKET });
        const req: any = {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: {
                data: Buffer.from("json hello").toString("base64"),
                fileName: "j.txt",
                mimeType: "text/plain",
            },
            get(h: string) {
                return req.headers[h.toLowerCase()];
            },
        };
        const { res, finished } = mockResponse();
        await handler(req, res);
        const result = await finished;

        expect(result.body.message).toBe("success");
        const [buf] = await storage.bucket(BUCKET).file(result.body.key).download();
        expect(buf.toString()).toBe("json hello");
    });

    it("responds to CORS preflight (OPTIONS)", async () => {
        const handler = handle({ bucketName: BUCKET });
        const req: any = {
            method: "OPTIONS",
            headers: {},
            get() {
                return undefined;
            },
        };
        const { res, finished } = mockResponse();
        await handler(req, res);
        const result = await finished;
        expect(result.status).toBe(204);
    });

    it("sets contentDisposition when requested via multipart", async () => {
        const handler = handle({ bucketName: BUCKET });
        const { boundary, body } = buildMultipart([
            { name: "contentDisposition", value: "attachment" },
            { name: "file", filename: "report.pdf", contentType: "application/pdf", data: Buffer.from("%PDF-1.4 ...") },
        ]);
        const req: any = Object.assign(new EventEmitter(), {
            method: "POST",
            headers: { "content-type": `multipart/form-data; boundary=${boundary}` },
            rawBody: body,
            get(h: string) {
                return req.headers[h.toLowerCase()];
            },
            unpipe() {
                // no-op
            },
        });
        const { res, finished } = mockResponse();
        await handler(req, res);
        const result = await finished;
        const [meta] = await storage.bucket(BUCKET).file(result.body.key).getMetadata();
        expect(meta.contentDisposition).toContain("attachment");
        expect(meta.contentDisposition).toContain("report.pdf");
    });
});
