import "dotenv/config";
const config = {
    MISTRAL_API_KEY: process.env.MISTRAL_API_KEY || '',
    CLOUD_MODEL: process.env.CLOUD_MODEL || 'pixtral-12b-2409',
    CLOUD_BASE_URL: process.env.CLOUD_BASE_URL || '',
    vlmProvider: process.env.vlmprovider || process.env.VLM_PROVIDER || 'cloud',
    MAX_TOKENS: parseInt(process.env.MAX_TOKENS || '1024', 10),
    CONTEXT_BUDGET: parseInt(process.env.CONTEXT_BUDGET || '5500', 10)
};

export default config;