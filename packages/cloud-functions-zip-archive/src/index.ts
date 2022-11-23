import * as gcs from "@google-cloud/storage";
import archiver from "archiver";
export interface InitParams {
    bucketName: string;
    clientSecret?: string;
}

export interface RequestBody {
    outputPath: string;
    inputs: {
        path: string;
        archiveName: string;
    }[];
}
// see: https://cloud.google.com/functions/docs/writing/write-http-functions
export function handle(params: InitParams): Function {
    return async (req: any, res: any) => {
        const { clientSecret, bucketName } = params;
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
        const writeStream = bucket.file(body.outputPath).createWriteStream();
        archive.pipe(writeStream);
        await archive.finalize();
        res.status(200).json({
            outputPath: body.outputPath
        });
    };
}
