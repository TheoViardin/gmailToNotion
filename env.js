const dotenv = require("dotenv");
dotenv.config();

module.exports.default = {
  clientId: process.env.CLIENT_ID,
  clientSecret: process.env.CLIENT_SECRET,
  redirectUri: process.env.REDIRECT_URI,
  code: process.env.CODE,
  googleApiToken: process.env.GOOGLE_API_TOKEN,
  googleApiRefreshToken: process.env.GOOGLE_API_REFRESH_TOKEN,
  googleApiTokenExpiry: process.env.GOOGLE_API_TOKEN_EXPIRY,
  notionApiKey: process.env.NOTION_API_KEY,
  mainNotionPage: process.env.MAIN_NOTION_PAGE,
};
