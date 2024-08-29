const { getFormatedMails } = require("./google");
const { addClientMails, getExistingClients } = require("./notion");
const logger = require("../logger");

async function importMailsIntoNotion() {
  const mails = await getFormatedMails();

  let mailCount = 0;

  if (mails.values()) {
    mailCount = Array.from(mails.values()).flat(1).length;
  }

  logger.info(`${mailCount} mail(s) récupérés, pour ${mails.size} client(s)`);

  if (mails) {
    const existingClients = await getExistingClients();

    for (let [client, clientMails] of mails) {
      await addClientMails(existingClients, client, clientMails);
    }
  }

  logger.info("Execution terminée");
}

module.exports = {
  importMailsIntoNotion,
};
