# @google-cloud-suite/cloud-functions-storage-upload

Upload file to storage via functions

1. Install

```
npm install @google-cloud-suite/cloud-functions-cloud-functions-storage-upload
```

3. Handle stroage trigger

You can use `handle(params?: InitParams)` to initialize trigger. The followings are the property of InitParams:

- clientSecret?: string
  - defaults: `undefined`

Examples:

- Using event target bucket for both source and destination.

```index.js
const storageUpload = require("@google-cloud-suite/cloud-functions-storage-upload");
exports.upload = storageUpload.handle();
```

4. Deploy

```
gcloud functions deploy upload \
--runtime nodejs14 \
--project YOUR_PROJECT
```
