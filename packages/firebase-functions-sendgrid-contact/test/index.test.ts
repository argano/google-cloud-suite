// NOTE: src/index.ts accesses req.data which matches the v2 (gen 2) CallableRequest signature,
// but uses the v1 `functions.https.onCall` (whose handler is `(data, context)`). These tests
// mock onCall to be identity so we exercise the handler's internal logic — they do NOT verify
// that production deployment works. See review notes for the suggested fix.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, setApiKeyMock } = vi.hoisted(() => ({
    sendMock: vi.fn(),
    setApiKeyMock: vi.fn(),
}));

vi.mock("firebase-admin", () => ({
    initializeApp: vi.fn(),
    default: { initializeApp: vi.fn() },
}));

vi.mock("@sendgrid/mail", () => {
    const api = { setApiKey: setApiKeyMock, send: sendMock };
    return { __esModule: true, default: api, ...api };
});

vi.mock("firebase-functions", () => {
    class HttpsError extends Error {
        constructor(
            public code: string,
            message: string,
        ) {
            super(message);
        }
    }
    return {
        https: {
            onCall: (handler: any) => handler,
            HttpsError,
        },
    };
});

import { handle } from "../src";

describe("handle (sendgrid-contact)", () => {
    beforeEach(() => {
        sendMock.mockReset();
        setApiKeyMock.mockReset();
        sendMock.mockResolvedValue(undefined);
    });

    it("sends a single email when only body is given", async () => {
        const fn = handle({
            apiKey: "key-xxx",
            emailFrom: "noreply@example.com",
            emailTo: "support@example.com",
            defaultSubject: "Default Subject",
        });
        await fn({ data: { body: "Hello there" } }, {} as any);

        expect(setApiKeyMock).toHaveBeenCalledWith("key-xxx");
        expect(sendMock).toHaveBeenCalledTimes(1);
        expect(sendMock).toHaveBeenCalledWith(
            expect.objectContaining({
                from: "noreply@example.com",
                to: "support@example.com",
                subject: "Default Subject",
                text: "Hello there",
            }),
        );
    });

    it("uses request subject when supplied", async () => {
        const fn = handle({
            apiKey: "k",
            emailFrom: "f@x",
            emailTo: "t@x",
            defaultSubject: "default",
        });
        await fn({ data: { body: "b", subject: "custom subject" } }, {} as any);
        expect(sendMock).toHaveBeenLastCalledWith(expect.objectContaining({ subject: "custom subject" }));
    });

    it("also sends a reply when reply config + replyBody + replyTo are provided", async () => {
        const fn = handle({
            apiKey: "k",
            emailFrom: "f@x",
            emailTo: "t@x",
            reply: { defaultSubject: "Reply default" },
        });
        await fn(
            {
                data: {
                    body: "main body",
                    replyBody: "reply body",
                    replyTo: "user@example.com",
                },
            },
            {} as any,
        );
        expect(sendMock).toHaveBeenCalledTimes(2);
        expect(sendMock).toHaveBeenLastCalledWith(
            expect.objectContaining({
                to: "user@example.com",
                subject: "Reply default",
                text: "reply body",
            }),
        );
    });

    it("does not send reply when reply config missing", async () => {
        const fn = handle({ apiKey: "k", emailFrom: "f@x", emailTo: "t@x" });
        await fn({ data: { body: "b", replyBody: "rb", replyTo: "u@x" } }, {} as any);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("throws HttpsError(invalid-argument) when body missing", async () => {
        const fn = handle({ apiKey: "k", emailFrom: "f@x", emailTo: "t@x" });
        await expect(fn({ data: {} }, {} as any)).rejects.toThrow(/missing email\/name\/body/);
    });

    it("throws HttpsError(failed-precondition) when sendgrid fails", async () => {
        sendMock.mockRejectedValueOnce("smtp boom");
        const fn = handle({ apiKey: "k", emailFrom: "f@x", emailTo: "t@x" });
        await expect(fn({ data: { body: "x" } }, {} as any)).rejects.toThrow();
    });
});
