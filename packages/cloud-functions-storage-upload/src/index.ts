import * as gcs from "@google-cloud/storage";
import csprng from "csprng";
import * as uuid from "uuid";
import * as mime from "mime-types";
import Busboy from "busboy";

export interface InitParams {
    clientSecret?: string;
    bucketName: string;
    keyPrefix?: string;
}

function createKey(keyPrefix: string | undefined, fileName: string, mimeType: string): string {
    const ext = (() => {
        const m = mime.extension(mimeType);
        if (m) {
            return m;
        } else {
            const chunk = fileName.split(".");
            return chunk[chunk.length - 1];
        }
    })();
    return (keyPrefix || "") + Date.now() + "/" + csprng(326, 36) + "/" + uuid.v4() + "." + ext;
}
function handleFormData(params: InitParams, req: any, res: any): void {
    const { clientSecret, bucketName, keyPrefix } = params;
    res.header("Access-Control-Allow-Origin", "*");
    res.header("Access-Control-Allow-Headers", "Origin, X-Requested-With, Content-Type, Accept");

    const storage = new gcs.Storage();
    const bucket = storage.bucket(bucketName);

    const fields: any = {};
    const busboy = new Busboy({ headers: req.headers });
    let filePath = "";
    busboy.on("field", (fieldName, value) => {
        fields[fieldName] = value;
    });
    busboy.on("file", (_1, file, fileName, _2, mimeType) => {
        if (clientSecret && fields["secret"] !== clientSecret) {
            req.unpipe(busboy);
            res.status(400).json({
                message: "Invalid secret(set secret before file)"
            });
            return;
        }
        const contentDisposition = fields["contentDisposition"];
        filePath = createKey(keyPrefix || "", fileName, mimeType);
        const bucketFile = bucket.file(filePath);
        const stream = bucketFile.createWriteStream();
        file.on("end", () => {
            stream.end();
        });
        stream.on("error", e => {
            console.error(e);
            res.status(500).json({
                message: "Failed to save file(stream error)"
            });
        });
        stream.on("finish", () => {
            (async () => {
                if (contentDisposition && (contentDisposition === "inline" || contentDisposition === "attachment")) {
                    const file = bucket.file(filePath);
                    await file.setMetadata({
                        contentDisposition: `${contentDisposition};filename=${fileName};filename*=UTF-8''${encodeURIComponent(fileName)}`
                    });
                }
                res.json({
                    message: "success",
                    key: filePath,
                    publicUrl: "https://storage.googleapis.com/" + bucketName + "/" + filePath
                });
            })().catch(() => {
                res.status(500).json({
                    message: "Failed to save file(finalize error)"
                });
            });
        });
        file.pipe(stream);
    });
    busboy.on("finish", () => {
        // nop
    });
    busboy.end(req.rawBody);
}

async function handleJSON(params: InitParams, req: any, res: any): Promise<void> {
    const { clientSecret, bucketName, keyPrefix } = params;
    const { data, fileName, mimeType, secret, contentDisposition } = req.body;
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
    const filePath = createKey(keyPrefix || "", fileName, mimeType);
    await saveFile(filePath, Buffer.from(data, "base64"), mimeType);
    if (contentDisposition && (contentDisposition === "inline" || contentDisposition === "attachment")) {
        const file = bucket.file(filePath);
        await file.setMetadata({
            contentDisposition: `${contentDisposition};filename=${fileName};filename*=UTF-8''${encodeURIComponent(fileName)}`
        });
    }
    res.json({
        message: "success",
        key: filePath,
        publicUrl: "https://storage.googleapis.com/" + bucketName + "/" + filePath
    });
}

// see: https://cloud.google.com/functions/docs/calling/storage
export function handle(params: InitParams): Function {
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
        if (req.get("content-type").indexOf("multipart/form-data") === 0) {
            return handleFormData(params, req, res);
        } else {
            return handleJSON(params, req, res);
        }
    };
}
