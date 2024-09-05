const base64url = require("base64url");
const { google } = require("googleapis");
const environment = require("../env");
const config = require("../config.json");
const { writeFile } = require("node:fs/promises");
const express = require("express");
const { NodeHtmlMarkdown } = require("node-html-markdown");
const moment = require("moment-timezone");
const logger = require("../logger");
const { Readable } = require("stream");
const { readdir } = require("node:fs/promises");
const path = require("path");

var labelId;
var folderId;

function getHandledEmailAddresses() {
  const handledEmailAddresses = [];
  for (let client of config.clients) {
    for (let handledEmailAddress of client.emailAddresses) {
      handledEmailAddresses.push(handledEmailAddress);
    }
  }

  return handledEmailAddresses;
}

function isHandledEmailAddress(fromEmailAddress, toEmailAddress) {
  for (let client of config.clients) {
    for (let handledEmailAddress of client.emailAddresses) {
      if (
        fromEmailAddress.includes(handledEmailAddress) ||
        toEmailAddress.includes(handledEmailAddress)
      ) {
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

async function saveGoogleTokens(
  userConfigPath,
  code,
  token,
  refreshToken,
  expiry,
) {
  let configPath = userConfigPath;

  if (!configPath) {
    console.log("test");
    configPath = await getNewConfigFilePath();
    console.log("test");
  }

  await writeFile(
    configPath,
    JSON.stringify({
      code,
      google_api_token: token,
      google_api_refresh_token: refreshToken,
      google_api_token_expiry: expiry,
    }),
  );
}

function requestGoogleAuthorizationCode() {
  const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive.file",
  ];

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

    await saveGoogleTokens(
      null,
      req.query.code,
      tokens.access_token,
      tokens.refresh_token,
      tokens.expiry_date,
    );

    throw new Error(
      "Votre boite mail a été ajoutée ! Les mails commenceront à être importés à la prochain execution",
    );
  });

  app.listen(3000, () => {
    logger.info(
      "Veuillez vous rendre sur le lien pour connecter votre boite mail",
    );
    console.log(url);
  });
}

async function refreshAuthToken(userConfig) {
  const time = Math.floor(new Date().getTime() / 1000);
  if (userConfig.config.google_api_token_expiry <= time) {
    const tokens = await oAuth2Client.refreshAccessToken();

    await saveGoogleTokens(
      userConfig.path,
      userConfig.config.code,
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

async function getGmailClient(userConfig) {
  oAuth2Client.setCredentials({
    access_token: userConfig.config.google_api_token,
    refresh_token: userConfig.config.google_api_refresh_token,
    expiry_date: userConfig.config.google_api_token_expiry,
  });

  await refreshAuthToken(userConfig);

  return google.gmail({ version: "v1", auth: oAuth2Client });
}

async function getDriveClient(userConfig) {
  oAuth2Client.setCredentials({
    access_token: userConfig.config.google_api_token,
    refresh_token: userConfig.config.google_api_refresh_token,
    expiry_date: userConfig.config.google_api_token_expiry,
  });

  await refreshAuthToken(userConfig);

  return google.drive({ version: "v3", auth: oAuth2Client });
}

function buildGmailQuery() {
  const handledEmailAddresses = getHandledEmailAddresses();

  let fromEmailQuery = handledEmailAddresses.join(" from:");
  let toEmailQuery = handledEmailAddresses.join(" to:");

  if (fromEmailQuery) {
    fromEmailQuery = `{from:${fromEmailQuery}}`;
  }

  if (toEmailQuery) {
    toEmailQuery = `{to:${toEmailQuery}}`;
  }

  const emailQuery = `${fromEmailQuery} OR ${toEmailQuery} NOT label:importedInNotion`;

  logger.info(emailQuery);

  return emailQuery;
}

async function getFormatedMails(userConfig) {
  try {
    const gmail = await getGmailClient(userConfig);

    labelId = await getLabelId(userConfig);

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
        let files = [];
        const parts = msg.data.payload.parts;

        // Find the body in the payload parts (usually plain text or HTML)
        if (parts && parts.length > 0) {
          const part = parts.find((part) => part.mimeType === "text/html");

          if (part && part.body && part.body.data) {
            body = base64url.decode(part.body.data);
          }

          files = parts?.filter(
            (part) => part.filename && part.body && part.body?.attachmentId,
          );
        } else {
          // Fallback to the main body if no parts are found
          body = msg.data.payload.body
            ? base64url.decode(msg.data.payload.body.data)
            : "";
        }

        body = NodeHtmlMarkdown.translate(body);

        /*body = htmlToText(body, {
          wordwrap: false, // Preserve the original formatting without wrapping text
        });*/

        let client = isHandledEmailAddress(from, to);

        if (!client) {
          client = "ignored_client";
        }

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

    return emailData;
  } catch (error) {
    logger.error(error);
    return new Map();
  }
}

async function getLabelId(userConfig) {
  const gmail = await getGmailClient(userConfig);

  const labels = await gmail.users.labels.list({
    userId: "me",
  });

  const botLabel = labels.data.labels.find(
    (label) => label.name === "importedInNotion",
  );

  return botLabel?.id;
}

async function getFolderId(userConfig) {
  try {
    const folderName = "gmailToNotion";

    const drive = await getDriveClient(userConfig);

    // Recherche du dossier par son nom
    const res = await drive.files.list({
      q: `name='${folderName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
      fields: "files(id, name)",
      spaces: "drive",
      supportsAllDrives: true,
    });

    const files = res.data.files;

    if (files.length > 0) {
      // Si le dossier existe, retourner son ID
      return files[0].id;
    } else {
      // Sinon, créer un nouveau dossier
      const fileMetadata = {
        name: folderName,
        mimeType: "application/vnd.google-apps.folder",
        supportsAllDrives: true
      };

      const folder = await drive.files.create({
        resource: fileMetadata,
        fields: "id",
      });

      logger.info(`Dossier créé avec l'ID: ${folder.data.id}`);
      return folder.data.id;
    }
  } catch (error) {
    logger.error(
      "Erreur lors de la recherche ou de la création du dossier:",
      error,
    );
  }
}

async function markMailAsHandled(userConfig, email) {
  const gmail = await getGmailClient(userConfig);

  const response = await gmail.users.messages.modify({
    userId: "me",
    id: email.id,
    requestBody: {
      addLabelIds: [labelId],
    },
  });

  logger.info(`Mail "${email.subject}" marqué comme importé`);

  return response;
}

async function pushFileToDrive(userConfig, messageId, file) {
  const gmail = await getGmailClient(userConfig);
  const drive = await getDriveClient(userConfig);

  const attachment = await gmail.users.messages.attachments.get({
    userId: "me",
    messageId,
    id: file.body?.attachmentId,
  });

  const fileData = attachment.data.data;
  const bufferStream = new Readable();
  bufferStream._read = () => {}; // No-op
  bufferStream.push(Buffer.from(fileData, "base64")); // Décodage base64
  bufferStream.push(null);

  if (!folderId) {
    folderId = await getFolderId(userConfig);
  }

  // Stockage de la pièce jointe dans Google Drive
  const fileMetadata = {
    name: `${messageId}_${file.filename}`,
    parents: [folderId],
    supportsAllDrives: true,
  };

  const media = {
    mimeType: "application/octet-stream",
    body: bufferStream,
  };

  const response = await drive.files.create({
    resource: fileMetadata,
    media: media,
    fields: "id",
  });

  const fileId = response.data.id;
  const fileLink = `https://drive.google.com/file/d/${fileId}/view?usp=sharing`;

  logger.info(`Fichier ${fileLink} uploadé`);

  return { url: fileLink, name: file.filename };
}

async function getNewConfigFilePath() {
  console.log("testhei");
  const fileList = await readdir("./users");
  console.log("testhei2");
  console.log(fileList);
  const userConfigPaths = fileList.filter(
    (file) => path.extname(file) === ".json",
  );

  return `./users/user_${userConfigPaths.length + 1}.json`;
}

module.exports = {
  requestGoogleAuthorizationCode,
  getFormatedMails,
  markMailAsHandled,
  pushFileToDrive,
};
