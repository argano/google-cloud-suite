import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { google } from "googleapis";

admin.initializeApp();

export interface AttachmentData {
    content: string;
    filename: string;
    type?: string;
    disposition?: string;
    contentId?: string;
}

export interface InitParams {
    /**
     * Full Secret Manager resource name of the service account JSON key.
     * Format: `projects/<PROJECT_ID>/secrets/<SECRET_ID>/versions/<VERSION>`
     * Example: `projects/my-project/secrets/gmail-sa-key/versions/latest`
     * The secret payload must be the service account JSON containing `client_email` and `private_key`.
     */
    secretVersionName: string;
    /**
     * Email address of the user the service account impersonates via domain-wide delegation.
     * Gmail API sends mail on behalf of this user.
     */
    impersonatedUser: string;
    emailFrom: string;
    emailTo: string;
    defaultSubject?: string;
    reply?: {
        defaultSubject?: string;
    };
}

interface ServiceAccountKey {
    client_email: string;
    private_key: string;
}

const secretClient = new SecretManagerServiceClient();
const credentialsCache = new Map<string, ServiceAccountKey>();

async function loadServiceAccount(secretName: string): Promise<ServiceAccountKey> {
    const cached = credentialsCache.get(secretName);
    if (cached) {
        return cached;
    }
    const [version] = await secretClient.accessSecretVersion({ name: secretName });
    const payload = version.payload?.data?.toString();
    if (!payload) {
        throw new Error(`empty secret payload for ${secretName}`);
    }
    const parsed = JSON.parse(payload) as ServiceAccountKey;
    credentialsCache.set(secretName, parsed);
    return parsed;
}

function encodeHeader(value: string): string {
    return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function buildRawMessage(opts: { from: string; to: string; subject: string; body: string; attachments?: AttachmentData[] }): string {
    const { from, to, subject, body, attachments } = opts;
    const headers = [`From: ${from}`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0"];
    let message: string;
    if (attachments && attachments.length > 0) {
        const boundary = `boundary_${Date.now().toString(16)}_${Math.random().toString(16).slice(2)}`;
        headers.push(`Content-Type: multipart/mixed; boundary="${boundary}"`);
        const parts: string[] = [];
        parts.push(`--${boundary}`);
        parts.push("Content-Type: text/plain; charset=UTF-8");
        parts.push("Content-Transfer-Encoding: 7bit");
        parts.push("");
        parts.push(body);
        for (const a of attachments) {
            parts.push(`--${boundary}`);
            parts.push(`Content-Type: ${a.type || "application/octet-stream"}; name="${a.filename}"`);
            parts.push(`Content-Disposition: ${a.disposition || "attachment"}; filename="${a.filename}"`);
            if (a.contentId) {
                parts.push(`Content-ID: <${a.contentId}>`);
            }
            parts.push("Content-Transfer-Encoding: base64");
            parts.push("");
            parts.push(a.content);
        }
        parts.push(`--${boundary}--`);
        message = `${headers.join("\r\n")}\r\n\r\n${parts.join("\r\n")}`;
    } else {
        headers.push("Content-Type: text/plain; charset=UTF-8");
        message = `${headers.join("\r\n")}\r\n\r\n${body}`;
    }
    return Buffer.from(message).toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function handle(params: InitParams): Function {
    return functions.https.onCall(async (req) => {
        const { body, subject, replyBody, replyTo, replySubject, attachments } = req.data;
        if (!body) {
            throw new functions.https.HttpsError("invalid-argument", "missing email/name/body");
        }
        try {
            const credentials = await loadServiceAccount(params.secretVersionName);
            const auth = new google.auth.JWT({
                email: credentials.client_email,
                key: credentials.private_key,
                scopes: ["https://www.googleapis.com/auth/gmail.send"],
                subject: params.impersonatedUser,
            });
            const gmail = google.gmail({ version: "v1", auth });
            await gmail.users.messages.send({
                userId: "me",
                requestBody: {
                    raw: buildRawMessage({
                        from: params.emailFrom,
                        to: params.emailTo,
                        subject: subject || params.defaultSubject || "",
                        body,
                        attachments,
                    }),
                },
            });
            if (params.reply && replyBody && replyTo) {
                await gmail.users.messages.send({
                    userId: "me",
                    requestBody: {
                        raw: buildRawMessage({
                            from: params.emailFrom,
                            to: replyTo,
                            subject: replySubject || params.reply.defaultSubject || "",
                            body: replyBody,
                        }),
                    },
                });
            }
        } catch (e) {
            throw new functions.https.HttpsError("failed-precondition", e as string);
        }
    });
}
