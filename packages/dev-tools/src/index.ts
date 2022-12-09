import * as functions from "firebase-functions";
import * as admin from "firebase-admin";
import * as sendGrid from "@sendgrid/mail";

admin.initializeApp();

export interface InitParams {
    apiKey: string;
    emailFrom: string;
    emailTo: string;
    subject: string;
    reply?: {
        subject: string;
    };
}

export function handle(params: InitParams): Function {
    return functions.https.onCall(async (data) => {
        const { body, replyBody, replyTo } = data;
        if (!body) {
            throw new functions.https.HttpsError("invalid-argument", "missing email/name/body");
        }
        sendGrid.setApiKey(params.apiKey);
        try {
            await sendGrid.send({
                from: params.emailFrom,
                to: params.emailTo,
                subject: params.subject,
                text: body
            });
            if (params.reply && replyBody && replyTo) {
                await sendGrid.send({
                    from: params.emailFrom,
                    to: params.emailTo,
                    subject: params.reply.subject,
                    text: replyBody
                });
            }
        } catch (e) {
            throw new functions.https.HttpsError("failed-precondition", e as string);
        }
    })
}
