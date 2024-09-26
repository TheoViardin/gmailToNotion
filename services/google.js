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

// Set up OAuth2 client with credentials from environment variables
const oAuth2Client = new google.auth.OAuth2(
  environment.default.clientId,
  environment.default.clientSecret,
  environment.default.redirectUri,
);

/**
 * Retrieves list of handled email addresses
 * @returns {array}
 */
function getHandledEmailAddresses() {
  const handledEmailAddresses = [];
  for (let client of config.clients) {
    for (let handledEmailAddress of client.emailAddresses) {
      handledEmailAddresses.push(handledEmailAddress);
    }
  }

  return handledEmailAddresses;
}

/**
 * Checks if the origin email address of the destination email address are handled by the app and returns the corresponding client name
 * @param {string} fromEmailAddress
 * @param {string} toEmailAddress
 * @returns {string}
 */
function isHandledMail(userEmailAddress, fromEmailAddress, toEmailAddress, cc) {
  if (
    cc == userEmailAddress &&
    (fromEmailAddress.contains(`@${environment.default.clientDomain}`) || toEmailAddress.contains(`@${environment.default.clientDomain}`))
  ) {
    // If the user is in copie and another yellodit user is already in the from or to, don't import, it will be importer for another user
    return null;
  }

  for (let client of config.clients) {
    for (let handledEmailAddress of client.emailAddresses) {
      if (
        fromEmailAddress.includes(handledEmailAddress.trim()) ||
        toEmailAddress.includes(handledEmailAddress.trim())
      ) {
        return client.name;
      }
    }
  }

  return null;
}

/**
 * Save the newly generate user authentication data to his file
 * @param {string} userConfigPath
 * @param {string} code
 * @param {string} token
 * @param {string} refreshToken
 * @param {number} expiry
 */
async function saveGoogleTokens(
  userConfigPath,
  code,
  token,
  refreshToken,
  expiry,
) {
  let configPath = userConfigPath;

  if (!configPath) {
    configPath = await getNewConfigFilePath();
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

/**
 * Generate link to let user allow access for the script to his google account
 * Launches a temporary express server which will handle the google response once the user accepts the terms
 */
function requestGoogleAuthorizationCode() {
  const scopes = [
    "https://www.googleapis.com/auth/gmail.modify",
    "https://www.googleapis.com/auth/drive.file",
    "https://www.googleapis.com/auth/userinfo.email",
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

/**
 * Checks wether user credentials are still up to date or triggers theirs renewal
 * @param {object} userConfig
 */
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

/**
 * Generates a gmail client object to be used for all gmail api calls
 * @param {object} userConfig
 * @returns {google_v1.Gmail}
 */
async function getGmailClient(userConfig) {
  oAuth2Client.setCredentials({
    access_token: userConfig.config.google_api_token,
    refresh_token: userConfig.config.google_api_refresh_token,
    expiry_date: userConfig.config.google_api_token_expiry,
  });

  await refreshAuthToken(userConfig);

  return google.gmail({ version: "v1", auth: oAuth2Client });
}

/**
 * Generates a google drive client object to be used for all gmail api calls
 * @param {object} userConfig
 * @returns {google_v3.Drive}
 */
async function getDriveClient(userConfig) {
  oAuth2Client.setCredentials({
    access_token: userConfig.config.google_api_token,
    refresh_token: userConfig.config.google_api_refresh_token,
    expiry_date: userConfig.config.google_api_token_expiry,
  });

  await refreshAuthToken(userConfig);

  return google.drive({ version: "v3", auth: oAuth2Client });
}

/**
 * Generates a google oauth client object to be used for all auth api calls
 * @param {object} userConfig
 * @returns {google_v3.Drive}
 */
async function getOAuthClient(userConfig) {
  oAuth2Client.setCredentials({
    access_token: userConfig.config.google_api_token,
    refresh_token: userConfig.config.google_api_refresh_token,
    expiry_date: userConfig.config.google_api_token_expiry,
  });

  await refreshAuthToken(userConfig);

  return google.oauth2({
    auth: oAuth2Client,
    version: "v2",
  });
}

async function getUserEmailAddress(userConfig) {
  const oauthClient = await getOAuthClient(userConfig);

  const res = await oauthClient.userinfo.get();

  return res.data.email;
}

/**
 * Returns a gmail ready query
 * The query gets all mail with source or destination of one of the email address configured,
 * without the label gtn
 * @returns {string}
 */
function buildGmailQuery(emails) {
  let fromEmailQuery = emails.join(" from:");
  let toEmailQuery = emails.join(" to:");

  if (fromEmailQuery) {
    fromEmailQuery = `{from:${fromEmailQuery}}`;
  }

  if (toEmailQuery) {
    toEmailQuery = `{to:${toEmailQuery}}`;
  }

  const emailQuery = `${fromEmailQuery} OR ${toEmailQuery} NOT label:${environment.default.gmailLabel}`;

  logger.info(emailQuery);

  return emailQuery;
}

function splitArrayIntoChunks(arr, chunkSize = 10) {
  let result = [];
  for (let i = 0; i < arr.length; i += chunkSize) {
    result.push(arr.slice(i, i + chunkSize));
  }
  return result;
}

async function getMessages(userConfig) {
  const gmail = await getGmailClient(userConfig);

  const handledEmailAddresses = getHandledEmailAddresses();

  const splitedEmailAddresses = splitArrayIntoChunks(
    handledEmailAddresses,
    200,
  );

  const promises = splitedEmailAddresses.map(async (chunk) =>
    gmail.users.messages.list({
      userId: "me",
      maxResults: 10, // Number of emails to retrieve
      q: buildGmailQuery(chunk),
    }),
  );

  const rawResponses = await Promise.all(promises);

  let responses = [];
  rawResponses.forEach((response) =>
    responses.push(...(response.data.messages ? response.data.messages : [])),
  );

  return responses;
}

/**
 * Retrieves emails and formates their content to be used later
 * @param {object} userConfig
 * @returns {object}
 */
async function getFormatedMails(userConfig) {
  try {
    const gmail = await getGmailClient(userConfig);

    labelId = await getLabelId(userConfig);

    if (!labelId) {
      const label = await gmail.users.labels.create({
        userId: "me",
        requestBody: {
          name: "gtn",
          messageListVisibility: "show",
          labelListVisibility: "labelShow",
        },
      });

      labelId = label.data.id;
    }

    const messages = await getMessages(userConfig);

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
        const cc = headers.find((header) => header.name === "CC")?.value;
        const date = moment.unix(msg.data.internalDate / 1000).utc();

        // Extract the body of the email
        let body = "";
        let files = [];
        const parts = msg.data.payload.parts;
        // Find the body in the payload parts (usually plain text or HTML)
        if (parts && parts.length > 0) {
          let part = parts.find((part) => part.mimeType === "text/html");

          if (!part) {
            const alternativePart = parts.find((part) =>
              ["multipart/alternative", "multipart/related"].includes(
                part.mimeType,
              ),
            );
            part = alternativePart.parts.find(
              (part) => part.mimeType === "text/html",
            );
          }

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

        body = body
          .replaceAll(
            /(?:!\[([^\]]*)\]\(([^)]+)\))|(?:\[(!?\[.*?\]\([^)]+\))\]\(([^)]+)\))/g,
            "",
          )
          .replaceAll(/(\r?\n){2,}/g, "\n");

        /*body = htmlToText(body, {
          wordwrap: false, // Preserve the original formatting without wrapping text
        });*/

        const userEmailAddress = await getUserEmailAddress(userConfig);

        let client = isHandledMail(userEmailAddress, from, to, cc);

        if (!client) {
          client = "ignored";
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

/**
 * Returns the gmail internal ID of the label "gtn"
 * @param {object} userConfig
 * @returns string
 */
async function getLabelId(userConfig) {
  const gmail = await getGmailClient(userConfig);

  const labels = await gmail.users.labels.list({
    userId: "me",
  });

  const botLabel = labels.data.labels.find((label) => label.name === "gtn");

  return botLabel?.id;
}

/**
 * Returns the google drive internal ID of the "googleToNotion" directory
 * @param {object} userConfig
 * @returns {string}
 */
async function getFolderId(userConfig) {
  try {
    const drive = await getDriveClient(userConfig);

    // Recherche du dossier par son nom
    const res = await drive.files.list({
      q: `name='${environment.default.driveDirectoryName}' and mimeType='application/vnd.google-apps.folder' and trashed=false`,
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
        name: environment.default.driveDirectoryName,
        mimeType: "application/vnd.google-apps.folder",
        supportsAllDrives: true,
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

/**
 * Adds the label "gtn" to the email
 * @param {object} userConfig
 * @param {object} email
 * @returns {object}
 */
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

/**
 * Pushes a file to the write directory in google drive and returns its url and name
 * @param {object} userConfig
 * @param {string} messageId
 * @param {object} file
 * @returns {object} object containing the url and name of the uploaded file
 */
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

/**
 * Returns the path of a new user config file
 * @returns {string}
 */
async function getNewConfigFilePath() {
  const fileList = await readdir("./users");

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
