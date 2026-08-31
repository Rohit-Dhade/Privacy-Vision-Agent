import buildPromptRequest from "../services/promptBuilder.js";
import reason from "../providers/vlmProvider.js";
import validateAction from "../validation/ActionValidator.js";
import sessionService from "../services/sessionService.js";

async function handleAgentStep(req, res) {
    const payload = req.body;
    console.log(req.body)
    try {
        const history = sessionService.getHistory(payload.sessionId);
        console.log(`[SESSION CHECK] sessionId=${payload.sessionId} history.length=${history.length}`);
        const payloadwithHistory = {
            ...payload, actionHistory: history.length > 0 ? history : payload.actionHistory,
        };

        const request = buildPromptRequest(payloadwithHistory);
        const rawResponse = await reason(request);
        const result = validateAction(rawResponse, payload.domSkeleton);

        if (!result.ok) {
            return res.status(200).json({
                success: false,
                reason: result.reason,
                action: { action: "Wait", targetSelector: null, value: null, reasoning: "Validation failed; retry recommended." },
            })
        }
        sessionService.appendToHistory(payload.sessionId, result.action);

        return res.status(200).json({
            success: true,
            action: result.action
        });
    } catch (err) {
        console.error("Agent step failed:", err)
        return res.status(502).json({
            success: false,
            reason: "VLM call failed.",
            action: { action: "Wait", targetSelector: null, value: null, reasoning: "Upstream error; retry recommended." }
        })
    }
}

export default handleAgentStep;