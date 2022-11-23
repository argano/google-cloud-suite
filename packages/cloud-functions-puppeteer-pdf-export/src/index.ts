import * as gcs from "@google-cloud/storage";
import csprng from "csprng";
import * as uuid from "uuid";
import puppeteer from "puppeteer";
export interface InitParams {
    bucketName: string;
    clientSecret?: string;
    keyPrefix?: string;
}

// see: https://cloud.google.com/functions/docs/writing/write-http-functions
export function handle(params: InitParams): Function {
    return async (req: any, res: any) => {
        const { clientSecret, bucketName, keyPrefix } = params;
        const storage = new gcs.Storage();
        const bucket = storage.bucket(bucketName);

        const browser = await puppeteer.launch({
            headless: true,
            args: [
                "--headless",
                "--lang=ja",
                "--disable-gpu",
                "--disable-setuid-sandbox",
                "--no-first-run",
                "--no-sandbox",
                "--disable-setuid-sandbox",
                "--disable-dev-shm-usage",
                "--no-zygote"
            ]
        });
        const targetUrl = req.body.url;
        if (clientSecret && clientSecret !== req.body.secret) {
            req.status(403).json({
                message: "invalid secret"
            });
            return;
        }
        let status = -1;
        let publicUrl = "";
        try {
            const page = await browser.newPage();
            page.on("response", response => {
                if (response.url() === targetUrl) {
                    status = response.status();
                }
            });
            await page.goto(targetUrl, {
                waitUntil: ["load", "networkidle0"],
                timeout: 60 * 1000
            });
            const pdf = await page.pdf({
                landscape: true,
                printBackground: true,
                format: "A4"
            });
            const bucketFilePath = (keyPrefix || "") + Date.now() + "/" + csprng(326, 36) + "/" + uuid.v4() + ".pdf";

            const bucketFile = bucket.file(bucketFilePath);
            await bucketFile.save(pdf, {
                metadata: {
                    contentType: "application/pdf"
                }
            });
            publicUrl = "https://storage.googleapis.com/" + bucketName + "/" + bucketFilePath;
        } finally {
            await browser.close();
        }

        res.status(200).json({
            status,
            publicUrl
        });
    };
}
