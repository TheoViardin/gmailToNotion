const { getFormatedMails } = require("./google");
const { addClientMails, getExistingClients } = require("./notion");

async function importMailsIntoNotion() {
  const mails = await getFormatedMails();

  let mailCount = 0;

  if (mails.values()) {
    mailCount = Array.from(mails.values()).flat(1).length;
  }

  console.log(`${mailCount} mail(s) récupérés, pour ${mails.size} client(s)`);

  if (mails) {
    const existingClients = await getExistingClients();

    for (let [client, clientMails] of mails) {
      await addClientMails(existingClients, client, clientMails);
    }
  }

  console.log("Execution terminée");
}

module.exports = {
  importMailsIntoNotion,
};
