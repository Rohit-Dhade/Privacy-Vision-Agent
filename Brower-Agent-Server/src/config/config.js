import "dotenv/config";
const config = {
    MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
    vlmProvider: process.env.vlmprovider
};

export default config;