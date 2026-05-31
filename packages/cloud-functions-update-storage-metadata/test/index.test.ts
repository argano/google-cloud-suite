import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

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
import { handleStorageObjectCreated } from "../src";

const BUCKET = "test-update-metadata";
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

describe("handleStorageObjectCreated", () => {
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

    it("merges metadata from sibling .metadata file into source file", async () => {
        const bucket = storage.bucket(BUCKET);
        await bucket.file("hello.txt").save(Buffer.from("hello"), {
            metadata: { contentType: "text/plain" },
        });
        await bucket.file("hello.txt.metadata").save(JSON.stringify({ metadata: { foo: "bar" } }));

        const handler = handleStorageObjectCreated();
        await handler(
            { bucket: BUCKET, name: "hello.txt" },
            { eventType: "google.storage.object.finalize" },
        );

        const [meta] = await bucket.file("hello.txt").getMetadata();
        expect(meta.metadata?.foo).toBe("bar");
    });

    it("ignores non-finalize events", async () => {
        const bucket = storage.bucket(BUCKET);
        await bucket.file("skip.txt").save(Buffer.from("x"), {
            metadata: { metadata: { keep: "yes" } },
        });
        await bucket.file("skip.txt.metadata").save(JSON.stringify({ metadata: { foo: "should-not-apply" } }));

        const handler = handleStorageObjectCreated();
        await handler(
            { bucket: BUCKET, name: "skip.txt" },
            { eventType: "google.storage.object.delete" },
        );

        const [meta] = await bucket.file("skip.txt").getMetadata();
        expect(meta.metadata?.foo).toBeUndefined();
        expect(meta.metadata?.keep).toBe("yes");
    });

    it("does not run on the .metadata file itself", async () => {
        const bucket = storage.bucket(BUCKET);
        await bucket.file("orig.txt.metadata").save(JSON.stringify({ metadata: { foo: "bar" } }));

        const handler = handleStorageObjectCreated();
        await handler(
            { bucket: BUCKET, name: "orig.txt.metadata" },
            { eventType: "google.storage.object.finalize" },
        );

        const [meta] = await bucket.file("orig.txt.metadata").getMetadata();
        expect(meta.metadata?.foo).toBeUndefined();
    });
});
