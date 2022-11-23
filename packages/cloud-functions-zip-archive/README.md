# @google-cloud-suite/cloud-functions-zip-archive

Create zip file on Cloud Storage

1. Install

```
npm install @google-cloud-suite/cloud-functions-zip-archive
```

3. Handle http trigger

You can use `handle(params?: InitParams)` to initialize trigger. The followings are the property of InitParams:

- bucketName: string
- clientSecret?: string
  - defaults: `undefined`

Examples:


```index.js
const zipArchive = require("@google-cloud-suite/cloud-functions-zip-archive");
exports.zipArchive = zipArchive.handle();
```

4. Deploy

```
gcloud functions deploy zipArchive \
--runtime nodejs14 \
--project YOUR_PROJECT
```
