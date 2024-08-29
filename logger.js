const pino = require("pino");
const moment = require("moment-timezone");

const fileTransport = pino.transport({
  target: "pino/file",
  options: {
    destination: `${__dirname}/logs/${new moment().tz("Europe/Paris").format("DD-MM-YYYY")}.log`,
  },
});

module.exports = pino(
  {
    timestamp: pino.stdTimeFunctions.isoTime,
  },
  fileTransport,
);
