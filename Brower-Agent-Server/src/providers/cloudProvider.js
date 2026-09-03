import { Mistral } from "@mistralai/mistralai";
import config from "../config/config.js";

function getClient() {
    return new Mistral({
        apiKey: config.MISTRAL_API_KEY
    });
}

/**
 * Normalizes message contents for Mistral Pixtral chat completions.
 * Pixtral accepts text chunks and image_url chunks with imageUrl.
 */
function normalizeMistralMessages(messages) {
    if (!Array.isArray(messages)) return [];
    return messages.map(msg => {
        if (typeof msg.content === 'string') return msg;
        if (Array.isArray(msg.content)) {
            const normalizedContent = msg.content.map(part => {
                if (part.type === 'text') {
                    return { type: 'text', text: part.text };
                }
                if (part.type === 'image_url') {
                    const url = typeof part.image_url === 'string'
                        ? part.image_url
                        : (part.image_url?.url || part.imageUrl || '');
                    return {
                        type: 'image_url',
                        imageUrl: url
                    };
                }
                return part;
            });
            return { ...msg, content: normalizedContent };
        }
        return msg;
    });
}

async function callCloudVLM(request) {
    const client = getClient();
    const model = request.model || config.CLOUD_MODEL || 'pixtral-12b-2409';
    const messages = normalizeMistralMessages(request.messages);
    const maxTokens = request.max_tokens || config.MAX_TOKENS || 1024;
    const temperature = request.temperature ?? 0.1;

    let response;
    try {
        response = await client.chat.complete({
            model,
            messages,
            maxTokens,
            temperature
        });
    } catch (sdkErr) {
        throw new Error(`Mistral Pixtral call failed: ${sdkErr.message}`);
    }

    let messageContent = response.choices?.[0]?.message?.content;
    if (Array.isArray(messageContent)) {
        messageContent = messageContent.map(c => c.text || c).join('\n');
    }

    if (!messageContent) {
        throw new Error("Cloud VLM response contained no message content.");
    }

    return messageContent;
}

export default callCloudVLM;