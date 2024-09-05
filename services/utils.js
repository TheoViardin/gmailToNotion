const { getFormatedMails, markMailAsHandled } = require("./google");
const { addClientMails, getExistingClients } = require("./notion");
const logger = require("../logger");
const { readdir, readFile } = require("node:fs/promises");
const path = require("path");

async function importMailsIntoNotion() {
  const userConfigs = await getUserConfigs();

  for (let userConfig of userConfigs) {
    logger.info(`Beginning import for user ${userConfig.path}`);

    const mails = await getFormatedMails(userConfig);

    let mailCount = 0;

    if (mails.values()) {
      mailCount = Array.from(mails.values()).flat(1).length;
    }

    logger.info(`${mailCount} mail(s) récupérés, pour ${mails.size} client(s)`);

    if (mails) {
      const existingClients = await getExistingClients();

      for (let [client, clientMails] of mails) {
        if (client === "ignored_client") {
          logger.info(`"${clientMails.length}" ignoré(s)`);
        } else {
          await addClientMails(
            userConfig,
            existingClients,
            client,
            clientMails,
          );
        }

        for (let email of clientMails) {
          await markMailAsHandled(userConfig, email);
          logger.info(`Mail "${email.subject}" géré`);
        }
      }
    }

    logger.info(`Finished import for user ${userConfig.path}`);
  }

  logger.info("Execution terminée");
}

async function getUserConfigs() {
  const fileList = await readdir("./users");
  const userConfigPaths = fileList.filter(
    (file) => path.extname(file) === ".json",
  );

  let userConfigs = [];

  for (let userConfigPath of userConfigPaths) {
    const userConfig = await readFile(`./users/${userConfigPath}`, {
      encoding: "utf8",
    });

    userConfigs.push({
      path: `./users/${userConfigPath}`,
      config: JSON.parse(userConfig),
    });
  }

  return userConfigs;
}

module.exports = {
  importMailsIntoNotion,
};
