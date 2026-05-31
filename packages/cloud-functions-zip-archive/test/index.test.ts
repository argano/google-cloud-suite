import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { Readable } from "stream";
import { spawnSync } from "child_process";

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

const BUCKET = "test-zip-archive";
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

function mockResponse() {
    let statusCode = 200;
    let bodyJson: any;
    let resolver: ((v: any) => void) | undefined;
    const finished = new Promise<{ status: number; body: any }>((r) => {
        resolver = r;
    });
    const res: any = {
        status(code: number) {
            statusCode = code;
            return res;
        },
        json(b: any) {
            bodyJson = b;
            resolver?.({ status: statusCode, body: bodyJson });
            return res;
        },
    };
    return { res, finished };
}

describe("handle (zip-archive)", () => {
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

    it("creates a zip archive containing the requested files", async () => {
        const bucket = storage.bucket(BUCKET);
        await bucket.file("a.txt").save(Buffer.from("alpha"));
        await bucket.file("b.txt").save(Buffer.from("beta"));

        const handler = handle({ bucketName: BUCKET });
        const req: any = {
            body: {
                outputPath: "out.zip",
                inputs: [
                    { path: "a.txt", archiveName: "alpha.txt" },
                    { path: "b.txt", archiveName: "beta.txt" },
                ],
            },
        };
        const { res, finished } = mockResponse();
        await handler(req, res);
        const result = await finished;

        expect(result.status).toBe(200);
        expect(result.body.outputPath).toBe("out.zip");

        // NOTE: handler returns before the upload writeStream finishes (pre-existing bug:
        // archive.finalize() is awaited but the underlying GCS write is not). Poll until the
        // object actually exists so the test is deterministic. See review notes.
        const outFile = bucket.file("out.zip");
        for (let i = 0; i < 50; i++) {
            const [exists] = await outFile.exists();
            if (exists) {
                break;
            }
            await new Promise((r) => setTimeout(r, 100));
        }

        const [zipBuf] = await outFile.download();
        // ZIP magic bytes
        expect(zipBuf.subarray(0, 4)).toEqual(Buffer.from([0x50, 0x4b, 0x03, 0x04]));

        // unzip with system unzip and check contents
        const { writeFileSync, mkdtempSync, readdirSync, readFileSync } = await import("fs");
        const { tmpdir } = await import("os");
        const { join } = await import("path");
        const dir = mkdtempSync(join(tmpdir(), "vitest-zip-"));
        const zipPath = join(dir, "out.zip");
        writeFileSync(zipPath, zipBuf);
        const r = spawnSync("unzip", ["-o", zipPath, "-d", dir], { encoding: "utf8" });
        expect(r.status, r.stderr).toBe(0);
        const entries = readdirSync(dir).sort();
        expect(entries).toContain("alpha.txt");
        expect(entries).toContain("beta.txt");
        expect(readFileSync(join(dir, "alpha.txt"), "utf8")).toBe("alpha");
        expect(readFileSync(join(dir, "beta.txt"), "utf8")).toBe("beta");
    });

    it("rejects when inputs is empty", async () => {
        const handler = handle({ bucketName: BUCKET });
        const req: any = { body: { inputs: [] } };
        const { res, finished } = mockResponse();
        await handler(req, res);
        const result = await finished;
        expect(result.status).toBe(400);
    });
});
