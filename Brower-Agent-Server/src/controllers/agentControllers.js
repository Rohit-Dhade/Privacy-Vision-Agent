import buildPromptRequest from "../services/promptBuilder.js";
import reason from "../providers/vlmProvider.js";
import validateAction from "../validation/ActionValidator.js";
import sessionService from "../services/sessionService.js";

async function handleAgentStep(req, res) {
    const payload = req.body;
    try {
        const serverHistory = sessionService.getHistory(payload.sessionId);
        const clientHistory = Array.isArray(payload.actionHistory) ? payload.actionHistory : [];
        const effectiveHistory = clientHistory.length > 0 ? clientHistory : serverHistory;

        console.log(`[SESSION] sessionId=${payload.sessionId} clientHistory=${clientHistory.length} serverHistory=${serverHistory.length}`);

        const payloadWithHistory = {
            ...payload,
            actionHistory: effectiveHistory,
        };

        const request = buildPromptRequest(payloadWithHistory);
        if (request._metrics) {
            console.log(`[VLM CONTEXT] taskTokens=${request._metrics.taskTokens} systemTokens=${request._metrics.systemTokens} stateTokens=${request._metrics.stateTokens} historyTokens=${request._metrics.historyTokens} domTokens=${request._metrics.domTokens} pageContextTokens=${request._metrics.pageContextTokens} visualTokens=${request._metrics.visualTokens} estimatedInputTokens=${request._metrics.estimatedInputTokens} maxOutputTokens=${request._metrics.maxOutputTokens} estimatedTotal=${request._metrics.estimatedTotal} budget=${request._metrics.budgetLimit} withinBudget=${request._metrics.withinBudget}`);
        }
        const rawResponse = await reason(request);
        const result = validateAction(rawResponse, payload.domSkeleton);

        if (!result.ok) {
            return res.status(200).json({
                success: false,
                reason: result.reason,
                action: { action: "wait", targetSelector: null, value: null, reasoning: "Validation failed; retry recommended." },
            });
        }
        sessionService.appendToHistory(payload.sessionId, result.action);

        return res.status(200).json({
            success: true,
            action: result.action
        });
    } catch (err) {
        console.error("Agent step failed:", err);
        return res.status(502).json({
            success: false,
            reason: "VLM call failed.",
            action: { action: "wait", targetSelector: null, value: null, reasoning: "Upstream error; retry recommended." }
        });
    }
}

export default handleAgentStep;