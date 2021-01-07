# @google-cloud-suite/cloud-functions-update-storage-metadata

Update object metadata with created trigger.

## What is this?

1. Save `file.txt.metadata` on your bucket

```
{
  "contentDisposition": "attachment:filename=textfile.txt"
}
```

2. When `file.txt` is created, this function set metadata from `file.txt.metadata` to `file.txt`.

## How to use?

1. Prepare your Google Cloud Functions directory.

```
functions
  |- package.json
  |- index.js
  |- .gcloudignore
 ...
```

2. Install

```
npm install @google-cloud-suite/cloud-functions-update-storage-metadata
```

3. Handle stroage trigger

You can use `handleStorageObjectCreated(params: InitParams)` to initialize trigger. The followings are the property of InitParams:

- metadataFileSuffix?: string
  - defaults: `.metadata`

Examples:

- Using event target bucket for both source and destination.

```index.js
const updateMetadata = require("@google-cloud-suite/cloud-functions-update-storage-metadata");
exports.updateMetadata = updateMetadata.handleStorageObjectCreated();
```

4. Deploy

```
gcloud functions deploy updateMetadata \
--runtime nodejs10 \
--trigger-resource YOUR_BUCKET \
--trigger-event google.storage.object.finalize \
--project YOUR_PROJECT
```
