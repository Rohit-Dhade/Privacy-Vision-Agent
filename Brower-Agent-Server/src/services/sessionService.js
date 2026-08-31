const sessions = new Map();

function getHistory(sessionId) {
    return sessions.get(sessionId) || [];
}

function appendToHistory(sessionId, action) {
    const history = getHistory(sessionId);
    const updated = [...history, { ...action, timestamp: Date.now() }];
    sessions.set(sessionId, updated);
    return updated;
}

function clearSession(sessionId) {
    sessions.delete(sessionId);
}

export default { getHistory, appendToHistory, clearSession };