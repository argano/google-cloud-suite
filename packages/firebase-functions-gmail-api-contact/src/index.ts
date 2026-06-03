import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import { SecretManagerServiceClient } from "@google-cloud/secret-manager";
import { google, gmail_v1 } from "googleapis";
import type { OAuth2Client, JWT } from "google-auth-library";

admin.initializeApp();

const GMAIL_SEND_SCOPE = "https://www.googleapis.com/auth/gmail.send";

export interface AttachmentData {
    content: string;
    filename: string;
    type?: string;
    disposition?: string;
    contentId?: string;
}

interface BaseParams {
    emailFrom: string;
    emailTo: string;
    fromName?: string;
    defaultSubject?: string;
    reply?: {
        defaultSubject?: string;
        fromName?: string;
    };
}

export interface ServiceAccountInitParams extends BaseParams {
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
}

export interface OAuthInitParams extends BaseParams {
    /**
     * Full Secret Manager resource name of the OAuth credentials JSON.
     * Format: `projects/<PROJECT_ID>/secrets/<SECRET_ID>/versions/<VERSION>`
     * The secret payload must be JSON with `client_id`, `client_secret`, and `refresh_token`
     * obtained via OAuth 2.0 consent (offline access) for the sending mailbox with `gmail.send` scope.
     */
    secretVersionName: string;
}

interface ServiceAccountKey {
    client_email: string;
    private_key: string;
}

interface OAuthCredentials {
    client_id: string;
    client_secret: string;
    refresh_token: string;
}

const secretClient = new SecretManagerServiceClient();
const secretCache = new Map<string, unknown>();

async function loadSecretJson<T>(secretVersionName: string): Promise<T> {
    const cached = secretCache.get(secretVersionName);
    if (cached) {
        return cached as T;
    }
    const [version] = await secretClient.accessSecretVersion({ name: secretVersionName });
    const payload = version.payload?.data?.toString();
    if (!payload) {
        throw new Error(`empty secret payload for ${secretVersionName}`);
    }
    const parsed = JSON.parse(payload) as T;
    secretCache.set(secretVersionName, parsed);
    return parsed;
}

function encodeHeader(value: string): string {
    return `=?UTF-8?B?${Buffer.from(value).toString("base64")}?=`;
}

function buildRawMessage(opts: { from: string; fromName?: string; to: string; subject: string; body: string; attachments?: AttachmentData[] }): string {
    const { from, fromName, to, subject, body, attachments } = opts;
    const fromHeader = fromName ? `${encodeHeader(fromName)} <${from}>` : from;
    const headers = [`From: ${fromHeader}`, `To: ${to}`, `Subject: ${encodeHeader(subject)}`, "MIME-Version: 1.0"];
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

type GmailAuth = JWT | OAuth2Client;

async function sendThroughGmail(
    auth: GmailAuth,
    params: BaseParams,
    req: {
        body: string;
        subject?: string;
        replyBody?: string;
        replyTo?: string;
        replySubject?: string;
        attachments?: AttachmentData[];
    },
): Promise<void> {
    const gmail = google.gmail({ version: "v1", auth: auth as gmail_v1.Options["auth"] });
    const send = (raw: string) =>
        gmail.users.messages.send({
            userId: "me",
            requestBody: { raw },
        });
    await send(
        buildRawMessage({
            from: params.emailFrom,
            fromName: params.fromName,
            to: params.emailTo,
            subject: req.subject || params.defaultSubject || "",
            body: req.body,
            attachments: req.attachments,
        }),
    );
    if (params.reply && req.replyBody && req.replyTo) {
        await send(
            buildRawMessage({
                from: params.emailFrom,
                fromName: params.reply.fromName || params.fromName,
                to: req.replyTo,
                subject: req.replySubject || params.reply.defaultSubject || "",
                body: req.replyBody,
            }),
        );
    }
}

function asHandler(handler: (req: any) => Promise<void>): Function {
    return functions.https.onCall(async (req) => {
        const { body } = req.data;
        if (!body) {
            throw new functions.https.HttpsError("invalid-argument", "missing email/name/body");
        }
        try {
            await handler(req);
        } catch (e) {
            throw new functions.https.HttpsError("failed-precondition", e as string);
        }
    });
}

export function handleWithServiceAccount(params: ServiceAccountInitParams): Function {
    return asHandler(async (req) => {
        const credentials = await loadSecretJson<ServiceAccountKey>(params.secretVersionName);
        const auth = new google.auth.JWT({
            email: credentials.client_email,
            key: credentials.private_key,
            scopes: [GMAIL_SEND_SCOPE],
            subject: params.impersonatedUser,
        });
        await sendThroughGmail(auth, params, req.data);
    });
}

export function handleWithOAuth(params: OAuthInitParams): Function {
    return asHandler(async (req) => {
        const credentials = await loadSecretJson<OAuthCredentials>(params.secretVersionName);
        const auth = new google.auth.OAuth2(credentials.client_id, credentials.client_secret);
        auth.setCredentials({ refresh_token: credentials.refresh_token });
        await sendThroughGmail(auth, params, req.data);
    });
}
