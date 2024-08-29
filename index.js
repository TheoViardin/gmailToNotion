const { importMailsIntoNotion } = require("./services/utils");
const { requestGoogleAuthorizationCode } = require("./services/google");

async function main() {
  if (!process.env.CODE) {
    requestGoogleAuthorizationCode();
  } else {
    await importMailsIntoNotion();
  }
}

main();
