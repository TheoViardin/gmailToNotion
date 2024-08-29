const base64url = require("base64url");
const { google } = require("googleapis");
const environment = require("../env");
const config = require("../config.json");
const fs = require("fs");
const envfile = require("envfile");
const express = require("express");
const { NodeHtmlMarkdown } = require("node-html-markdown");
const moment = require("moment");

var labelId;

function getHandledEmailAddresses() {
  const handledEmailAddresses = [];
  for (let client of config.clients) {
    for (let handledEmailAddress of client.emailAddresses) {
      handledEmailAddresses.push(handledEmailAddress);
    }
  }

  return handledEmailAddresses;
}

function isHandledEmailAddress(emailAddress) {
  for (let client of config.clients) {
    for (let handledEmailAddress of client.emailAddresses) {
      if (emailAddress.includes(handledEmailAddress)) {
        return client.name;
      }
    }
  }

  return null;
}

// Set up OAuth2 client with credentials from environment variables
const oAuth2Client = new google.auth.OAuth2(
  environment.default.clientId,
  environment.default.clientSecret,
  environment.default.redirectUri,
);

async function saveGoogleTokens(code, token, refreshToken, expiry) {
  const file = fs.readFileSync(".env");

  let parsedFile = envfile.parse(file);

  parsedFile.CODE = code;
  parsedFile.GOOGLE_API_TOKEN = token;
  parsedFile.GOOGLE_API_REFRESH_TOKEN = refreshToken;
  parsedFile.GOOGLE_API_TOKEN_EXPIRY = expiry;

  fs.writeFileSync(".env", envfile.stringify(parsedFile));
}

function requestGoogleAuthorizationCode() {
  const scopes = ["https://www.googleapis.com/auth/gmail.modify"];

  const url = oAuth2Client.generateAuthUrl({
    // 'online' (default) or 'offline' (gets refresh_token)
    access_type: "offline",

    // If you only need one scope, you can pass it as a string
    scope: scopes,
  });

  const app = express();

  app.get("/redirect", async (req, res) => {
    res.status(200).json(req.query);

    const { tokens } = await oAuth2Client.getToken(req.query);

    saveGoogleTokens(
      req.query.code,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date,
    );

    throw new Error("Votre boite mail a été ajoutée ! Les mails commenceront à être importés à la prochain execution");
  });

  app.listen(3000, () => {
    console.debug("Veuillez cliquer sur le lien pour connecter votre boite mail");
    console.log(url);
  });
}

async function refreshAuthToken() {
  const time = Math.floor(new Date().getTime() / 1000);
  if (environment.default.googleApiTokenExpiry <= time) {
    const tokens = await oAuth2Client.refreshAccessToken();

    saveGoogleTokens(
      environment.default.code,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date,
    );

    oAuth2Client.setCredentials({
      access_token: tokens.access_token,
      refresh_token: tokens.refresh_token,
      expiry_date: tokens.expiry_date,
    });
  }
}

async function getGmailClient() {
  oAuth2Client.setCredentials({
    access_token: environment.default.googleApiToken,
    refresh_token: environment.default.googleApiRefreshToken,
    expiry_date: environment.default.googleApiTokenExpiry,
  });

  await refreshAuthToken();

  return google.gmail({ version: "v1", auth: oAuth2Client });
}

function buildGmailQuery() {
  const handledEmailAddresses = getHandledEmailAddresses();

  let formatedEmailQuery = handledEmailAddresses.join(" from:");

  if (formatedEmailQuery) {
    formatedEmailQuery = `{from:${formatedEmailQuery}}`;
  }

  return `label:inbox ${formatedEmailQuery} NOT label:importedInNotion`;
}

async function getFormatedMails() {
  try {
    const gmail = await getGmailClient();

    labelId = await getLabelId();

    if (!labelId) {
      const label = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: "importedInNotion",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
        },
      });

      labelId = label.data.id;
    }

    const response = await gmail.users.messages.list({
      userId: "me",
      maxResults: 10, // Number of emails to retrieve
      q: buildGmailQuery(),
    });

    const messages = response.data.messages;

    const emailData = new Map();

    if (messages) {
      for (let message of messages) {
        const msg = await gmail.users.messages.get({
          userId: "me",
          id: message.id,
        });

        const headers = msg.data.payload.headers;

        const subject = headers.find(
          (header) => header.name === "Subject",
        ).value;
        const from = headers.find((header) => header.name === "From").value;
        const to = headers.find((header) => header.name === "To").value;
        const date = moment.unix(msg.data.internalDate / 1000).utc();

        // Extract the body of the email
        let body = "";
        const parts = msg.data.payload.parts;

        // Find the body in the payload parts (usually plain text or HTML)
        if (parts && parts.length > 0) {
          const part = parts.find((part) => part.mimeType === "text/html");

          if (part && part.body && part.body.data) {
            body = base64url.decode(part.body.data);
          }
        } else {
          // Fallback to the main body if no parts are found
          body = msg.data.payload.body
            ? base64url.decode(msg.data.payload.body.data)
            : "";
        }

        const files = parts.filter((part) => part.filename);

        body = NodeHtmlMarkdown.translate(body);

        /*body = htmlToText(body, {
          wordwrap: false, // Preserve the original formatting without wrapping text
        });*/

        const client = isHandledEmailAddress(from);

        if (client) {
          let emailsForClient = emailData.get(client);

          if (!emailsForClient) {
            emailsForClient = [];
          }

          emailsForClient.push({
            id: message.id,
            subject,
            date,
            from,
            to,
            body,
            files,
          });

          emailData.set(client, emailsForClient);
        }
      }
    }

    return emailData;
  } catch (error) {
    console.log(error);
    return new Map();
  }
}

async function getLabelId() {
  const gmail = await getGmailClient();

  const labels = await gmail.users.labels.list({
    userId: "me",
  });

  const botLabel = labels.data.labels.find(
    (label) => label.name === "importedInNotion",
  );

  return botLabel?.id;
}

async function markMailAsHandled(email) {
  const gmail = await getGmailClient();

  const response = await gmail.users.messages.modify({
    userId: "me",
    id: email.id,
    requestBody: {
      addLabelIds: [labelId],
    },
  });

  console.log(`Mail "${email.subject}" marqué comme importé`);

  return response;
}

module.exports = {
  requestGoogleAuthorizationCode,
  getFormatedMails,
  markMailAsHandled,
};
