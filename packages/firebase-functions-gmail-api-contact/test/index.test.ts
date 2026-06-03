// NOTE: src/index.ts accesses req.data which matches the v2 (gen 2) CallableRequest signature,
// but uses the v1 `functions.https.onCall` (whose handler is `(data, context)`). These tests
// mock onCall to be identity so we exercise the handler's internal logic — they do NOT verify
// that production deployment works.
import { beforeEach, describe, expect, it, vi } from "vitest";

const { sendMock, accessSecretVersionMock, jwtMock, oauth2Mock, setCredentialsMock } = vi.hoisted(() => ({
    sendMock: vi.fn(),
    accessSecretVersionMock: vi.fn(),
    jwtMock: vi.fn(),
    oauth2Mock: vi.fn(),
    setCredentialsMock: vi.fn(),
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
            auth: { JWT: jwtMock, OAuth2: oauth2Mock },
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

import { handleWithServiceAccount, handleWithOAuth } from "../src";

const SERVICE_ACCOUNT_JSON = JSON.stringify({
    client_email: "robot@project.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nFAKE\n-----END PRIVATE KEY-----\n",
});

const OAUTH_JSON = JSON.stringify({
    client_id: "client-abc.apps.googleusercontent.com",
    client_secret: "shhh",
    refresh_token: "1//refresh-token-value",
});

function decodeRaw(raw: string): string {
    const padded = raw.replace(/-/g, "+").replace(/_/g, "/");
    return Buffer.from(padded, "base64").toString("utf-8");
}

function resetAllMocks() {
    sendMock.mockReset();
    accessSecretVersionMock.mockReset();
    jwtMock.mockReset();
    oauth2Mock.mockReset();
    setCredentialsMock.mockReset();
    sendMock.mockResolvedValue({});
    jwtMock.mockImplementation(function (this: any, opts: any) {
        this.opts = opts;
    });
    oauth2Mock.mockImplementation(function (this: any, clientId: string, clientSecret: string) {
        this.clientId = clientId;
        this.clientSecret = clientSecret;
        this.setCredentials = setCredentialsMock;
    });
}

describe("handleWithServiceAccount", () => {
    beforeEach(() => {
        resetAllMocks();
        accessSecretVersionMock.mockResolvedValue([{ payload: { data: Buffer.from(SERVICE_ACCOUNT_JSON) } }]);
    });

    it("sends a single email when only body is given", async () => {
        const fn = handleWithServiceAccount({
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
        const fn = handleWithServiceAccount({
            secretVersionName: "sa-1",
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
        const fn = handleWithServiceAccount({
            secretVersionName: "sa-2",
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
        const fn = handleWithServiceAccount({
            secretVersionName: "sa-3",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await fn({ data: { body: "b", replyBody: "rb", replyTo: "u@x" } }, {} as any);
        expect(sendMock).toHaveBeenCalledTimes(1);
    });

    it("includes attachments as multipart parts", async () => {
        const fn = handleWithServiceAccount({
            secretVersionName: "sa-4",
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
        const fn = handleWithServiceAccount({
            secretVersionName: "sa-5",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await expect(fn({ data: {} }, {} as any)).rejects.toThrow(/missing email\/name\/body/);
    });

    it("throws HttpsError(failed-precondition) when gmail send fails", async () => {
        sendMock.mockRejectedValueOnce("smtp boom");
        const fn = handleWithServiceAccount({
            secretVersionName: "sa-6",
            impersonatedUser: "u@x",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await expect(fn({ data: { body: "x" } }, {} as any)).rejects.toThrow();
    });
});

describe("handleWithOAuth", () => {
    beforeEach(() => {
        resetAllMocks();
        accessSecretVersionMock.mockResolvedValue([{ payload: { data: Buffer.from(OAUTH_JSON) } }]);
    });

    it("constructs OAuth2 client from secret and sends a single email", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "projects/p/secrets/oauth/versions/latest",
            emailFrom: "noreply@example.com",
            emailTo: "support@example.com",
            defaultSubject: "Default Subject",
        });
        await fn({ data: { body: "Hello there" } }, {} as any);

        expect(accessSecretVersionMock).toHaveBeenCalledWith({
            name: "projects/p/secrets/oauth/versions/latest",
        });
        expect(oauth2Mock).toHaveBeenCalledWith("client-abc.apps.googleusercontent.com", "shhh");
        expect(setCredentialsMock).toHaveBeenCalledWith({ refresh_token: "1//refresh-token-value" });
        expect(sendMock).toHaveBeenCalledTimes(1);
        const decoded = decodeRaw(sendMock.mock.calls[0][0].requestBody.raw);
        expect(decoded).toContain("From: noreply@example.com");
        expect(decoded).toContain("To: support@example.com");
        expect(decoded).toContain("Hello there");
    });

    it("does not call JWT auth in oauth mode", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "oauth-1",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await fn({ data: { body: "b" } }, {} as any);
        expect(jwtMock).not.toHaveBeenCalled();
    });

    it("sends a reply when configured", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "oauth-2",
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
        expect(decoded).toContain("reply body");
    });

    it("throws HttpsError(invalid-argument) when body missing", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "oauth-3",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await expect(fn({ data: {} }, {} as any)).rejects.toThrow(/missing email\/name\/body/);
    });

    it("throws HttpsError(failed-precondition) when gmail send fails", async () => {
        sendMock.mockRejectedValueOnce("smtp boom");
        const fn = handleWithOAuth({
            secretVersionName: "oauth-4",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await expect(fn({ data: { body: "x" } }, {} as any)).rejects.toThrow();
    });

    it("uses fromName to build RFC 2047 encoded From header", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "oauth-5",
            emailFrom: "contact@example.com",
            emailTo: "ops@example.com",
            fromName: "Arganoお問い合わせ",
            defaultSubject: "Hello",
        });
        await fn({ data: { body: "b" } }, {} as any);
        const decoded = decodeRaw(sendMock.mock.calls[0][0].requestBody.raw);
        const expectedName = `=?UTF-8?B?${Buffer.from("Arganoお問い合わせ").toString("base64")}?=`;
        expect(decoded).toContain(`From: ${expectedName} <contact@example.com>`);
    });

    it("falls back to top-level fromName for reply when reply.fromName not set", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "oauth-6",
            emailFrom: "f@x",
            emailTo: "t@x",
            fromName: "送信者",
            reply: { defaultSubject: "RE" },
        });
        await fn(
            { data: { body: "m", replyBody: "r", replyTo: "u@x" } },
            {} as any,
        );
        const decoded = decodeRaw(sendMock.mock.calls[1][0].requestBody.raw);
        const expectedName = `=?UTF-8?B?${Buffer.from("送信者").toString("base64")}?=`;
        expect(decoded).toContain(`From: ${expectedName} <f@x>`);
    });

    it("uses reply.fromName over top-level fromName for reply mail", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "oauth-7",
            emailFrom: "f@x",
            emailTo: "t@x",
            fromName: "問い合わせ受付",
            reply: { defaultSubject: "RE", fromName: "Arganoサポート" },
        });
        await fn(
            { data: { body: "m", replyBody: "r", replyTo: "u@x" } },
            {} as any,
        );
        const mainDecoded = decodeRaw(sendMock.mock.calls[0][0].requestBody.raw);
        const replyDecoded = decodeRaw(sendMock.mock.calls[1][0].requestBody.raw);
        const mainName = `=?UTF-8?B?${Buffer.from("問い合わせ受付").toString("base64")}?=`;
        const replyName = `=?UTF-8?B?${Buffer.from("Arganoサポート").toString("base64")}?=`;
        expect(mainDecoded).toContain(`From: ${mainName} <f@x>`);
        expect(replyDecoded).toContain(`From: ${replyName} <f@x>`);
    });

    it("emits bare address when fromName is not given", async () => {
        const fn = handleWithOAuth({
            secretVersionName: "oauth-8",
            emailFrom: "f@x",
            emailTo: "t@x",
        });
        await fn({ data: { body: "b" } }, {} as any);
        const decoded = decodeRaw(sendMock.mock.calls[0][0].requestBody.raw);
        expect(decoded).toContain("From: f@x");
        expect(decoded).not.toMatch(/From: =\?UTF-8\?B/);
    });
});
