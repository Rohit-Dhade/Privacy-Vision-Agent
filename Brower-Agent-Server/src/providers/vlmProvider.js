import config from "../config/config.js";
import callCloudVLM from "./cloudProvider.js";

const providers = {
    cloud: callCloudVLM,
}

async function reason(request) {
    const provider = providers[config.vlmProvider]
    if (!provider) {
        throw new Error(`No provider implementation for VLM_PROVIDER="${config.vlmProvider}"`)
    }

    return provider(request);
}

export default reason;