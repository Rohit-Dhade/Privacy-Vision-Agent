import config from "../config/config.js";
import callCloudVLM from "./cloudProvider.js";

const providers = {
    cloud: callCloudVLM,
    mistral: callCloudVLM
};

async function reason(request) {
    const providerName = String(config.vlmProvider || "").trim().toLowerCase();
    const provider = providers[providerName] || providers.cloud;

    if (!provider) {
        throw new Error(`No provider implementation for VLM_PROVIDER="${config.vlmProvider}"`)
    }

    return provider(request);
}

export default reason;