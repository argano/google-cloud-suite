import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import sendGrid from "@sendgrid/mail";

admin.initializeApp();

export interface InitParams {
    apiKey: string;
    emailFrom: string;
    emailTo: string;
    defaultSubject?: string;
    reply?: {
        defaultSubject?: string;
    };
}

export function handle(params: InitParams): Function {
    return functions.https.onCall(async data => {
        const { body, subject, replyBody, replyTo, replySubject, attachments } = data;
        if (!body) {
            throw new functions.https.HttpsError("invalid-argument", "missing email/name/body");
        }
        sendGrid.setApiKey(params.apiKey);
        try {
            await sendGrid.send({
                from: params.emailFrom,
                to: params.emailTo,
                subject: subject || params.defaultSubject || "",
                text: body,
                attachments: attachments
            });
            if (params.reply && replyBody && replyTo) {
                await sendGrid.send({
                    from: params.emailFrom,
                    to: replyTo,
                    subject: replySubject || params.reply.defaultSubject || "",
                    text: replyBody
                });
            }
        } catch (e) {
            throw new functions.https.HttpsError("failed-precondition", e as string);
        }
    });
}
