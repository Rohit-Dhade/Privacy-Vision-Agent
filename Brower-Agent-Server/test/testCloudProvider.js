import "dotenv/config";
import buildPromptRequest from "../src/services/promptBuilder.js";
import callCloudVLM from "../src/providers/cloudProvider.js";
import validateAction from "../src/validation/ActionValidator.js";

const TINY_PNG_BASE64 =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=";

const samplePayload = {
    taskInstruction: "Click the submit button",
    domSkeleton: {
        url: "https://example.com",
        elements: [
            {
                id: "el_1",
                tag: "button",
                selector: "#submit-btn",
                box: { x: 10, y: 10, width: 80, height: 30 },
                sensitive: false,
            },
        ],
    },
    redactionMap: [],
    actionHistory: [],
    screenshot: {
        format: "png",
        dataBase64: TINY_PNG_BASE64,
        width: 1,
        height: 1,
    },
};


const fakeBadResponse = JSON.stringify({
    action: "fill",
    targetSelector: "#login-password",
    value: "hunter2",
    reasoning: "Filling in the password",
});

async function main() {

    const request = buildPromptRequest(samplePayload);
    console.log("--- Request being sent ---");
    console.log(JSON.stringify(request, null, 2));

    const rawResponse = await callCloudVLM(request);
    console.log("\n--- Raw VLM response ---");
    console.log(rawResponse);

    const badResult = validateAction(fakeBadResponse, {
        elements: [{ selector: "#login-password", sensitive: true }],
    });
    console.log("\n--- Validated action ---");
    console.log(badResult);
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});