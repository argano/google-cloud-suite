import * as gcs from "@google-cloud/storage";

export interface InitParams {
    metadataFileSuffix?: string;
}

// see: https://cloud.google.com/functions/docs/calling/storage
export function handleStorageObjectCreated(params: InitParams): Function {
    const metadataSuffix = params.metadataFileSuffix || ".metadata";
    function isTarget(eventType: string, file: string): boolean {
        if (eventType !== "google.storage.object.finalize") {
            return false;
        }
        if (file.lastIndexOf(metadataSuffix) === file.length - metadataSuffix.length) {
            return false;
        }
        return true;
    }
    return async (data: any, context: any) => {
        const eventType = context.eventType;
        const bucketName = data.bucket;
        const file = data.name;

        const storage = new gcs.Storage();
        const bucket = storage.bucket(bucketName);
        if (!isTarget(eventType, file)) {
            console.log(`Event is not target, bucket: ${bucket}, eventType: ${eventType}, file: ${file}`);
            return;
        }
        const [sourceFile] = await bucket.file(file).get();
        const [metadataFile] = await bucket.file(file + metadataSuffix).get();
        if (!metadataFile) {
            return;
        }
        const [metadataBuf] = await metadataFile.download();
        if (!metadataBuf) {
            return;
        }
        try {
            const metadata = JSON.parse(metadataBuf.toString("utf-8"));
            await sourceFile.setMetadata({
                metadata
            });
        } catch (e) {
            console.error(e);
        }
    };
}
