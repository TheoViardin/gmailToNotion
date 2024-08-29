const { Client } = require("@notionhq/client");
const { markMailAsHandled } = require("./google");
const environment = require("../env");

const notion = new Client({ auth: environment.default.notionApiKey });

function getPageContent(pageId, count = 100) {
  return notion.blocks.children.list({ block_id: pageId, page_size: count });
}

async function createPage(name) {
  const page = await notion.pages.create({
    parent: { page_id: "d2713c69dc6d41098db7d3675dfb58c9" },
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

  console.log(`Nouveau client "${name}" créé`);

  return page;
}

async function getExistingClients() {
  const mainPageContent = await getPageContent(
    "d2713c69dc6d41098db7d3675dfb58c9",
  );

  const existingClients = mainPageContent.results.map((block) => ({
    id: block.id,
    name: block.child_page.title,
  }));

  return existingClients || [];
}

function cleanEmailAddresses(emailAddress) {
  const emailRegex = /[\w.-]+@[\w.-]+\.[a-zA-Z]{2,}/g;

  const emailAddresses = emailAddress.match(emailRegex);

  return [...new Set(emailAddresses)];
}

function getClientId(existingClients, clientName) {
  return existingClients.find(
    (existingClient) => existingClient.name === clientName,
  );
}

async function getPageFirstBlock(pageId) {
  const pageDetails = await getPageContent(pageId, 1);

  return pageDetails.results[0];
}

async function addClientMails(existingClients, client, emails) {
  let clientDetails = getClientId(existingClients, client);

  let clientId = clientDetails?.id;

  if (!clientId) {
    const newPage = await createPage(client);

    clientId = newPage.id;
  }

  const firstBlock = await getPageFirstBlock(clientId);

  const block = {
    block_id: clientId,
    after: firstBlock?.id,
  };

  const children = [];

  for (let email of emails) {
    if (!email) return;

    console.log(`Importation de "${email.subject}"`);

    const chunks = [];
    for (let i = 0; i < email.body.length; i += 2000) {
      chunks.push(email.body.slice(i, i + 2000));
    }

    const object = {
      type: "text",
      text: {
        content: `Objet : ${email.subject}\n${email.date.format("DD/MM/YY à HH:mm")} - De : `,
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

    children.push({
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
        ],
      },
    });
    
    console.log(`Mail "${email.subject}" importé`);

    await markMailAsHandled(email);
  }

  block.children = children;

  await notion.blocks.children.append(block);
}

module.exports = {
  getExistingClients,
  addClientMails,
};
