import { Mistral } from "@mistralai/mistralai";
import config from "../config/config.js"

const client = new Mistral({
    apiKey: config.MISTRAL_API_KEY
});

async function callCloudVLM(mistralRequest) {
    const response = await client.chat.complete(mistralRequest)
    const messageContent = response.choices?.[0]?.message?.content;

    console.log("From cloudProvider file -> ", messageContent)

    if (!messageContent) {
        throw new Error("Cloud VLM response contained no message content.")
    }

    return messageContent;
}

export default callCloudVLM;