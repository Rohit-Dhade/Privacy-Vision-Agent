import "dotenv/config";
import fs from "fs";
import path from "path";

const SCREENSHOT_PATH = "test/BlackoutImage.png";

async function main() {
    const imageBuffer = fs.readFileSync(SCREENSHOT_PATH);
    const base64Data = imageBuffer.toString("base64");

    console.log(`Image file size: ${(imageBuffer.length / 1024).toFixed(1)} KB`);
    console.log(`Base64 encoded size: ${(base64Data.length / 1024).toFixed(1)} KB`);

    const payload = {
        sessionId: "large-screenshot-test-1",
        taskInstruction: "Describe what input elements that are visible and help me to fill out the form.",
        capturedAt: Date.now(),
        screenshot: {
            format: "png",
            dataBase64: base64Data,
            width: 1440,
            height: 900,
        },
        domSkeleton: {
            url: "https://example.com/test-page",
            elements: [
                { id: "el_1", tag: "input", type: "text", selector: "#fullName", box: { x: 20, y: 60, width: 260, height: 28 }, sensitive: false },
                { id: "el_2", tag: "input", type: "email", selector: "#email", box: { x: 20, y: 120, width: 260, height: 28 }, sensitive: false },
                { id: "el_3", tag: "input", type: "password", selector: "#password", box: { x: 20, y: 180, width: 260, height: 28 }, sensitive: true, redactionTag: "REDACTED_PASSWORD" },
                { id: "el_4", tag: "input", type: "text", selector: "#aadhaar", box: { x: 20, y: 240, width: 260, height: 28 }, sensitive: true, redactionTag: "REDACTED_AADHAAR" },
                { id: "el_5", tag: "input", type: "text", selector: "#pan", box: { x: 20, y: 300, width: 260, height: 28 }, sensitive: true, redactionTag: "REDACTED_PAN" },
                { id: "el_6", tag: "input", type: "password", selector: "#upiPin", box: { x: 20, y: 360, width: 260, height: 28 }, sensitive: true, redactionTag: "REDACTED_UPI_PIN" },
                { id: "el_7", tag: "button", type: "submit", selector: "button[type='submit']", box: { x: 20, y: 420, width: 100, height: 36 }, sensitive: false },
            ],
        },
        redactionMap: [
            { elementId: "el_3", type: "password_field", method: "blackout" },
            { elementId: "el_4", type: "govt_id_aadhaar", method: "blackout" },
            { elementId: "el_5", type: "govt_id_pan", method: "blackout" },
            { elementId: "el_6", type: "pin_field", method: "blackout" },
        ],
        actionHistory: [],
    };

    const start = Date.now();

    const response = await fetch("http://localhost:5000/api/agent/step", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
    });

    const duration = Date.now() - start;
    const result = await response.json();

    console.log(`\nStatus: ${response.status}`);
    console.log(`Round-trip time: ${duration}ms`);
    console.log("Response:", JSON.stringify(result, null, 2));
}

main().catch((err) => {
    console.error("Test failed:", err);
    process.exit(1);
});