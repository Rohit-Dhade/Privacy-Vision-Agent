const sessions = new Map();

function getHistory(sessionId) {
    return sessions.get(sessionId) || [];
}

function appendToHistory(sessionId, action) {
    const history = getHistory(sessionId);
    const compactAction = {
        action: action.action,
        targetSelector: action.targetSelector || null,
        elementId: action.elementId || null,
        timestamp: Date.now()
    };
    const updated = [...history.slice(-19), compactAction];
    sessions.set(sessionId, updated);
    return updated;
}

function clearSession(sessionId) {
    sessions.delete(sessionId);
}

export default { getHistory, appendToHistory, clearSession };