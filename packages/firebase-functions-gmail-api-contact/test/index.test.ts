// NOTE: src/index.ts accesses req.data which matches the v2 (gen 2) CallableRequest signature,
// but uses the v1 `functions.https.onCall` (whose handler is `(data, context)`). These tests
// mock onCall to be identity so we exercise the handler's internal logic — they do NOT verify
// that production deployment works.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, accessSecretVersionMock, jwtMock } = vi.hoisted(() => ({
    sendMock: vi.fn(),
    accessSecretVersionMock: vi.fn(),
    jwtMock: vi.fn(),
}));

vi.mock("firebase-admin", () => ({
    initializeApp: vi.fn(),
    default: { initializeApp: vi.fn() },
}));

vi.mock("@google-cloud/secret-manager", () => {
    class SecretManagerServiceClient {
        accessSecretVersion = accessSecretVersionMock;
    }
    return { SecretManagerServiceClient };
});

vi.mock("googleapis", () => {
    const gmail = () => ({
        users: { messages: { send: sendMock } },
    });
    return {
        google: {
            auth: { JWT: jwtMock },
            gmail,
        },
    };
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

const SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "robot@project.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
});

function decodeRaw(raw: string): string {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf-8");
}

describe("handle (gmail-api-contact)", () => {
    beforeEach(() => {
        sendMock.mockReset();
        accessSecretVersionMock.mockReset();
        jwtMock.mockReset();
        sendMock.mockResolvedValue({});
        accessSecretVersionMock.mockResolvedValue([{ payload: { data: Buffer.from(SERVICE_ACCOUNT_JSON) } }]);
        jwtMock.mockImplementation(function (this: any, opts: any) {
            this.opts = opts;
        });
    });

    it("sends a single email when only body is given", async () => {
        const fn = handle({
            secretVersionName: "projects/p/secrets/sa/versions/latest",
            impersonatedUser: "sender@example.com",
            emailFrom: "noreply@example.com",
            emailTo: "support@example.com",
            defaultSubject: "Default Subject",
        });
        await fn({ data: { body: "Hello there" } }, {} as any);

        expect(accessSecretVersionMock).toHaveBeenCalledWith({
            name: "projects/p/secrets/sa/versions/latest",
        });
        expect(jwtMock).toHaveBeenCalledWith(
            expect.objectContaining({
                email: "robot@project.iam.gserviceaccount.com",
                subject: "sender@example.com",
                scopes: ["https://www.googleapis.com/auth/gmail.send"],
            }),
        );
        expect(sendMock).toHaveBeenCalledTimes(1);
        const arg = sendMock.mock.calls[0][0];
        expect(arg.userId).toBe("me");
        const decoded = decodeRaw(arg.requestBody.raw);
        expect(decoded).toContain("From: noreply@example.com");
        expect(decoded).toContain("To: support@example.com");
        expect(decoded).toContain(`Subject: =?UTF-8?B?${Buffer.from("Default Subject").toString("base64")}?=`);
        expect(decoded).toContain("Hello there");
    });

    it("uses request subject when supplied", async () => {
        const fn = handle({
            secretVersionName: "n",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
            defaultSubject: "default",
        });
        await fn({ data: { body: "b", subject: "custom subject" } }, {} as any);
        const decoded = decodeRaw(sendMock.mock.calls[0][0].requestBody.raw);
        expect(decoded).toContain(`Subject: =?UTF-8?B?${Buffer.from("custom subject").toString("base64")}?=`);
    });

    it("also sends a reply when reply config + replyBody + replyTo are provided", async () => {
        const fn = handle({
            secretVersionName: "n",
            impersonatedUser: "u@x",
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
        const decoded = decodeRaw(sendMock.mock.calls[1][0].requestBody.raw);
        expect(decoded).toContain("To: user@example.com");
        expect(decoded).toContain(`Subject: =?UTF-8?B?${Buffer.from("Reply default").toString("base64")}?=`);
        expect(decoded).toContain("reply body");
    });

    it("does not send reply when reply config missing", async () => {
        const fn = handle({
            secretVersionName: "n",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await fn({ data: { body: "b", replyBody: "rb", replyTo: "u@x" } }, {} as any);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("includes attachments as multipart parts", async () => {
        const fn = handle({
            secretVersionName: "n",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await fn(
            {
                data: {
                    body: "see attached",
                    attachments: [
                        {
                            content: Buffer.from("PDF-DATA").toString("base64"),
                            filename: "report.pdf",
                            type: "application/pdf",
                        },
                    ],
                },
            },
            {} as any,
        );
        const decoded = decodeRaw(sendMock.mock.calls[0][0].requestBody.raw);
        expect(decoded).toContain("Content-Type: multipart/mixed");
        expect(decoded).toContain("Content-Type: application/pdf");
        expect(decoded).toContain('filename="report.pdf"');
        expect(decoded).toContain(Buffer.from("PDF-DATA").toString("base64"));
    });

    it("throws HttpsError(invalid-argument) when body missing", async () => {
        const fn = handle({
            secretVersionName: "n",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await expect(fn({ data: {} }, {} as any)).rejects.toThrow(/missing email\/name\/body/);
    });

    it("throws HttpsError(failed-precondition) when gmail send fails", async () => {
        sendMock.mockRejectedValueOnce("smtp boom");
        const fn = handle({
            secretVersionName: "n",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await expect(fn({ data: { body: "x" } }, {} as any)).rejects.toThrow();
    });
});
