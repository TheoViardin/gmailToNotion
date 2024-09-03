const { getFormatedMails, markMailAsHandled } = require("./google");
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
      if (client === 'ignored_client') {
        logger.info(`"${clientMails.length}" ignoré(s)`);
      } else {
        await addClientMails(existingClients, client, clientMails);
      }
      
      for (let email of clientMails) {
        await markMailAsHandled(email);
        logger.info(`Mail "${email.subject}" géré`);
      } 
    }
  }

  logger.info("Execution terminée");
}

module.exports = {
  importMailsIntoNotion,
};
