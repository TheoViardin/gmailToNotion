const { importMailsIntoNotion } = require("./services/utils");
const { requestGoogleAuthorizationCode } = require("./services/google");
const logger = require("./logger");

process.on("uncaughtException", (err) => {
  // log the exception
  logger.fatal(err, "uncaught exception detected");

  // If a graceful shutdown is not achieved after 1 second,
  // shut down the process completely
  setTimeout(() => {
    process.abort(); // exit immediately and generate a core dump file
  }, 1000).unref();
  process.exit(1);
});

async function main() {
  if (!process.env.CODE) {
    requestGoogleAuthorizationCode();
  } else {
    await importMailsIntoNotion();
  }
}

main();
