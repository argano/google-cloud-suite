import * as gcs from "@google-cloud/storage";
import archiver from "archiver";
import csprng from "csprng";
import * as uuid from "uuid";

export interface InitParams {
    bucketName: string;
    clientSecret?: string;
    keyPrefix?: string;
}

export interface RequestBody {
    outputPath?: string;
    inputs: {
        path: string;
        archiveName: string;
    }[];
}
// see: https://cloud.google.com/functions/docs/writing/write-http-functions
export function handle(params: InitParams): Function {
    return async (req: any, res: any) => {
        const { clientSecret, bucketName, keyPrefix } = params;
        const storage = new gcs.Storage();
        const bucket = storage.bucket(bucketName);
        const body: RequestBody = req.body;
        if (!body.outputPath) {
            res.status(400).json({
                message: "invalid outputPath"
            });
            return;
        }
        if (!(body.inputs && body.inputs.length)) {
            res.status(400).json({
                message: "invalid inputs"
            });
            return;
        }
        if (clientSecret && clientSecret !== req.body.secret) {
            req.status(403).json({
                message: "invalid secret"
            });
            return;
        }
        const archive = archiver("zip", {
            zlib: { level: 9 } // Sets the compression level.
        });
        body.inputs.forEach(input => {
            archive.append(bucket.file(input.path).createReadStream(), { name: input.archiveName });
        });
        const bucketFilePath = (keyPrefix || "") + (body.outputPath || Date.now() + "/" + csprng(326, 36) + "/" + uuid.v4() + ".zip");

        const writeStream = bucket.file(bucketFilePath).createWriteStream();
        archive.pipe(writeStream);
        await archive.finalize();
        const publicUrl = "https://storage.googleapis.com/" + bucketName + "/" + bucketFilePath;
        res.status(200).json({
            publicUrl: publicUrl,
            outputPath: bucketFilePath
        });
    };
}
