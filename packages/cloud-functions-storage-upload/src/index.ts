import * as gcs from "@google-cloud/storage";
import csprng from "csprng";
import * as uuid from "uuid";
import * as mime from "mime-types";

export interface InitParams {
    clientSecret?: string;
    bucketName: string;
    keyPrefix?: string;
}

// see: https://cloud.google.com/functions/docs/calling/storage
export function handle(params: InitParams): Function {
    const { clientSecret, bucketName, keyPrefix } = params;
    return async (req: any, res: any) => {
        if (req.method === "OPTIONS") {
            // CORS support
            res.set("Access-Control-Allow-Origin", "*");
            res.set("Access-Control-Allow-Methods", "POST");
            res.set("Access-Control-Allow-Headers", "Content-Type");
            res.set("Access-Control-Max-Age", "3600");
            res.status(204).send("");
            return;
        }

        const { data, fileName, mimeType, secret, addContentDispositionAttachment } = req.body;
        res.header("Access-Control-Allow-Origin", "*");
        res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");
        if (clientSecret && clientSecret !== secret) {
            res.status(401).json({ message: "invalid secret" });
        }

        const storage = new gcs.Storage();
        const bucket = storage.bucket(bucketName);

        const saveFile = (key: string, buf: Buffer, mimeType: string) => {
            return new Promise<void>((resolve, reject) => {
                const stream = bucket.file(key).createWriteStream({
                    metadata: {
                        contentType: mimeType
                    },
                    resumable: false
                });
                stream.on("error", err => {
                    reject(err);
                });
                stream.on("finish", () => {
                    resolve();
                });
                stream.end(buf);
            });
        };
        const ext = (() => {
            const m = mime.extension(mimeType);
            if (m) {
                return m;
            } else {
                const chunk = fileName.split(".");
                return chunk[chunk.length - 1];
            }
        })();
        const filePath = (keyPrefix || "") + Date.now() + "/" + csprng(326, 36) + "/" + uuid.v4() + "." + ext;
        await saveFile(filePath, Buffer.from(data, "base64"), mimeType);
        if (addContentDispositionAttachment) {
            const file = bucket.file(filePath);
            await file.setMetadata({
                contentDisposition: `attachment;filename=${fileName};filename*=UTF-8''${encodeURIComponent(fileName)}`
            });
        }
        res.json({
            message: "success",
            key: filePath,
            publicUrl: "https://storage.googleapis.com/" + bucketName + "/" + filePath
        });
    };
}
