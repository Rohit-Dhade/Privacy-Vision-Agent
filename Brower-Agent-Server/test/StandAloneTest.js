// Testing input and values for the Ghost buttons to check the validateAction working well. It gives the structured output if fails.


import validateAction from "../src/validation/ActionValidator.js";

const fakeHallucinatedResponse = JSON.stringify({
    action: "click",
    targetSelector: "#ghost-button",
    value: null,
    reasoning: "Clicking the ghost button as instructed.",
});

const domSkeleton = {
    url: "https://example.com",
    elements: [
        { id: "el_1", tag: "button", selector: "#submit-btn", box: { x: 10, y: 10, width: 80, height: 30 }, sensitive: false },
    ],
};

const result = validateAction(fakeHallucinatedResponse, domSkeleton);
console.log(result);