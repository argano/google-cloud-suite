# @google-cloud-suite/firebase-functions-sendgrid-contact

Send email by sendgrid

1. Install

```
npm install @google-cloud-suite/firebase-functions-sendgrid-contact
```

2. Handle http trigger

You can use `handle(params?: InitParams)` to initialize trigger. The followings are the property of InitParams:

- apiKey: string
- emailFrom: string
- emailTo: string
- subject: string
- reply?: { subject: string }
  - defaults: `undefined`

Examples:


```index.js
const sendgridContact = require("@google-cloud-suite/firebase-functions-sendgrid-contact");
exports.createContact = sendgridContact.handle({
   apiKey: "sgapikey",
   emailFrom: "no-reply@example.org",
   emailTo: "you@example.org",
   reply: { subject: "Thank you for your contact!" }
});
```

3. Call function

```
import { getFunctions, httpsCallable } from "firebase/functions";

const functions = getFunctions();
const createContact = httpsCallable(functions, "createContact");

contact body = "Hello, I have a quetion.";
createContact({ body })
  .then((result) => {
    alert("success");
  });

// If you want to reply thanks email to your customer
createContact({ body, replyBody: "You sent: " + body, replyTo: "customer@example.org"})
  .then((result) => {
    alert("success");
  });

```

4. Deploy

```
firebase deploy
```
