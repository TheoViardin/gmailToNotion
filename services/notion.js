const { Client } = require("@notionhq/client");
const environment = require("../env");
const moment = require("moment-timezone");
const logger = require("../logger");
const { pushFileToDrive } = require("./google");

const notion = new Client({ auth: environment.default.notionApiKey });

/**
 * Returns the content of the specified page
 * @param {number} pageId
 * @param {number} count
 * @returns {object}
 */
function getPageContent(pageId, count = 100) {
  return notion.blocks.children.list({ block_id: pageId, page_size: count });
}

/**
 * Creates and returns a notion page with the specified name
 * @param {string} name
 * @returns {object}
 */
async function createPage(name) {
  const page = await notion.pages.create({
    parent: { page_id: environment.default.mainNotionPage },
    properties: {
      title: {
        title: [
          {
            type: "text",
            text: {
              content: name,
            },
          },
        ],
      },
    },
    children: [
      {
        object: "block",
        heading_2: {
          rich_text: [
            {
              text: {
                content: "Emails",
              },
            },
          ],
        },
      },
    ],
  });

  logger.info(`Nouveau client "${name}" créé`);

  return page;
}

/**
 * Returns the existing client from the main notion page
 * @returns {array}
 */
async function getExistingClients() {
  const mainPageContent = await getPageContent(
    environment.default.mainNotionPage,
  );

  const existingClients = mainPageContent.results
    .filter((block) => block.child_page?.title)
    .map((block) => ({
      id: block.id,
      name: block.child_page.title,
    }));

  return existingClients || [];
}

/**
 * Cleans an email address for it to respect the email address format
 * @param {string} emailAddress
 * @returns {string}
 */
function cleanEmailAddresses(emailAddress) {
  const emailRegex = /[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g;

  const emailAddresses = emailAddress.match(emailRegex);

  return [...new Set(emailAddresses)];
}

/**
 * Returns the id of the searched user
 * @param {array} existingClients
 * @param {string} clientName
 * @returns {string}
 */
function getClientId(existingClients, clientName) {
  return existingClients.find(
    (existingClient) => existingClient.name === clientName,
  );
}

/**
 * Return the first element of a notion page
 * @param {string} pageId
 * @returns {object}
 */
async function getPageFirstBlock(pageId) {
  const pageDetails = await getPageContent(pageId, 1);

  return pageDetails.results[0];
}

/**
 * Adds mail from gmail to notion
 * @param {object} userConfig
 * @param {array} existingClients
 * @param {string} client
 * @param {array} emails
 */
async function addClientMails(userConfig, existingClients, client, emails) {
  let clientDetails = getClientId(existingClients, client);

  let clientId = clientDetails?.id;

  if (!clientId) {
    const newPage = await createPage(client);

    clientId = newPage.id;
  }

  const firstBlock = await getPageFirstBlock(clientId);

  const blockBefore = {
    block_id: clientId,
    after: firstBlock?.id,
  };

  const blockAfter = {
    block_id: clientId,
  };

  const children = { before: [], after: [] };

  for (let email of emails) {
    if (!email) return;

    logger.info(`Importation de "${email.subject}"`);

    const fileUrls = [];

    for (let file of email.files) {
      const url = await pushFileToDrive(userConfig, email.id, file);
      fileUrls.push(url);
    }

    const chunks = [];
    for (let i = 0; i < email.body.length && chunks.length < 100; i += 2000) {
      chunks.push(email.body.slice(i, i + 2000));
    }

    const object = {
      type: "text",
      text: {
        content: `Objet : ${email.subject}\n${email.date.tz("Europe/Paris").format("DD/MM/YY à HH:mm")} - De : `,
      },
      annotations: {
        bold: true,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
    };

    const fromBlocks = cleanEmailAddresses(email.from).map((emailAddress) => ({
      type: "text",
      text: {
        content: `${emailAddress} `,
        link: {
          type: "url",
          url: `mailto:${emailAddress}`,
        },
      },
    }));

    const toBlock = {
      type: "text",
      text: {
        content: `À : `,
      },
      annotations: {
        bold: true,
        italic: false,
        strikethrough: false,
        underline: false,
        code: false,
        color: "default",
      },
    };

    const toBlocks = cleanEmailAddresses(email.to).map((emailAddress) => ({
      type: "text",
      text: {
        content: `${emailAddress} `,
        link: {
          type: "url",
          url: `mailto:${emailAddress}`,
        },
      },
    }));

    email.body = email.body.replaceAll("\n", "\\n");

    const now = moment();

    const timeLimit = now.subtract({ minutes: 15 });

    if (email.date > timeLimit) {
      children.before.push({
        object: "block",
        type: "toggle",
        toggle: {
          rich_text: [object, ...fromBlocks, toBlock, ...toBlocks],
          children: [
            {
              object: "block",
              type: "quote",
              quote: {
                rich_text: chunks.map((chunk) => ({
                  type: "text",
                  text: {
                    content: chunk,
                  },
                })),
              },
            },
            ...fileUrls.map((file) => ({
              type: "file",
              file: {
                type: "external",
                external: {
                  url: file.url,
                },
                name: file.name,
              },
            })),
          ],
        },
      });
    } else {
      children.after.push({
        object: "block",
        type: "toggle",
        toggle: {
          rich_text: [object, ...fromBlocks, toBlock, ...toBlocks],
          children: [
            {
              object: "block",
              type: "quote",
              quote: {
                rich_text: chunks.map((chunk) => ({
                  type: "text",
                  text: {
                    content: chunk,
                  },
                })),
              },
            },
            ...fileUrls.map((file) => ({
              type: "file",
              file: {
                type: "external",
                external: {
                  url: file.url,
                },
                name: file.name,
              },
            })),
          ],
        },
      });
    }
  }

  blockBefore.children = children.before;
  blockAfter.children = children.after;

  await notion.blocks.children.append(blockBefore);
  await notion.blocks.children.append(blockAfter);
}

module.exports = {
  getExistingClients,
  addClientMails,
};
