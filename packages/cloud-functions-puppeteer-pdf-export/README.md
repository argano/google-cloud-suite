# @google-cloud-suite/cloud-functions-puppeteer-pdf-export

Create pdf of website screenshot

1. Install

```
npm install @google-cloud-suite/cloud-functions-puppeteer-pdf-export
```

3. Handle http trigger

You can use `handle(params?: InitParams)` to initialize trigger. The followings are the property of InitParams:

- bucketName: string
- clientSecret?: string
  - defaults: `undefined`
- keyPrefix?: string
  - defaults: `undefined`

Examples:


```index.js
const pdfExport = require("@google-cloud-suite/cloud-functions-puppeteer-pdf-export");
exports.pdfExport = pdfExport.handle();
```

4. Deploy

```
gcloud functions deploy pdfExport \
--runtime nodejs14 \
--project YOUR_PROJECT
```
