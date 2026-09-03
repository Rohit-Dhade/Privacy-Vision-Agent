import { z } from "zod";

const boxSchema = z.object({
    x: z.number(),
    y: z.number(),
    width: z.number(),
    height: z.number(),
});

const elementSchema = z.object({
    id: z.string(),
    tag: z.string(),
    type: z.string().optional(),
    selector: z.string(),
    box: boxSchema,
    sensitive: z.union([z.boolean(), z.literal("unknown")]),
    redactionTag: z.string().optional(),
    hasValue: z.boolean().optional(),
    // Semantic labels — page-authored metadata, never user-entered PII
    text: z.string().optional(),
    ariaLabel: z.string().optional(),
    placeholder: z.string().optional(),
    // Element state
    enabled: z.boolean().optional(),
    visible: z.boolean().optional(),
    // Special element metadata (already sent by frontend, now validated)
    options: z.array(z.object({ value: z.string(), label: z.string() })).optional(),
    radioGroup: z.array(z.object({
        value: z.string(),
        label: z.string(),
        checked: z.boolean()
    })).optional(),
    accept: z.string().optional(),
    multiple: z.boolean().optional(),
    isUntrustedPromptInjection: z.boolean().optional()
})

const redactionEntrySchema = z.object({
    elementId: z.string(),
    type: z.string(),
    method: z.enum(["blackout", "blur"]),
});

const actionHistoryItemSchema = z.object({
    action: z.string(),
    targetSelector: z.string().nullable().optional(),
    elementId: z.any().optional(),
    fieldName: z.string().optional(),
    value: z.string().nullable().optional().refine(val => {
        if (!val) return true;
        return val === '[REDACTED]' || val === '[FILLED_FROM_LOCAL]' || val === '[ALREADY_POPULATED]';
    }, { message: "Raw sensitive values forbidden in actionHistory" }),
    result: z.any().optional(),
    outcome: z.string().optional(),
    matchedKey: z.string().optional(),
    authorizedByUser: z.boolean().optional(),
    plan: z.any().optional(),
    extractedData: z.any().optional()
});

const requestSchema = z.object({
    sessionId: z.string(),
    taskInstruction: z.string(),
    capturedAt: z.number(),
    screenshot: z.object({
        format: z.enum(["png", "jpeg"]),
        dataBase64: z.string(),
        width: z.number(),
        height: z.number(),
    }),
    domSkeleton: z.object({
        url: z.string().url(),
        elements: z.array(elementSchema),
    }),

    redactionMap: z.array(redactionEntrySchema),
    actionHistory: z.array(actionHistoryItemSchema),
    stateDiff: z.object({
        urlChanged: z.boolean().optional(),
        navigationOccurred: z.boolean().optional(),
        previousUrl: z.string().nullable().optional(),
        currentUrl: z.string().optional(),
        addedElements: z.array(z.any()).optional(),
        removedElements: z.array(z.any()).optional(),
        changedElements: z.array(z.any()).optional(),
    }).optional(),
    userInteractions: z.array(z.any()).optional(),
    formSummary: z.object({
        formDetected: z.boolean(),
        totalFields: z.number(),
        alreadyCompleted: z.number(),
        emptyFields: z.number(),
        locallyMatchable: z.number(),
        requiresUserInput: z.number(),
    }).optional(),
    pageContext: z.object({
        activeModal: z.object({
            isOpen: z.boolean(),
            title: z.string().nullable().optional(),
            selector: z.string().nullable().optional()
        }).nullable().optional(),
        alerts: z.array(z.object({
            type: z.string(),
            text: z.string()
        })).optional(),
        loadingState: z.object({
            isLoading: z.boolean(),
            indicator: z.string().nullable().optional(),
            indicators: z.array(z.string()).optional()
        }).nullable().optional(),
        forms: z.array(z.object({
            id: z.string().optional(),
            fieldCount: z.number().optional(),
            populatedCount: z.number().optional(),
            hasSubmit: z.boolean().optional()
        })).optional()
    }).nullable().optional(),
    taskPlan: z.object({
        objective: z.string().optional(),
        constraints: z.array(z.string()).nullable().optional(),
        subgoals: z.array(z.object({
            id: z.string().optional(),
            title: z.string().optional(),
            description: z.string().optional(),
            status: z.string().optional()
        })).optional(),
        currentSubgoal: z.string().nullable().optional(),
        currentSubgoalIndex: z.number().optional(),
        totalSubgoals: z.number().optional(),
        activeSubgoal: z.any().optional(),
        gatheredInformation: z.record(z.string(), z.any()).nullable().optional(),
        isComplete: z.boolean().optional(),
        isTaskComplete: z.boolean().optional()
    }).nullable().optional(),
    taskMemory: z.object({
        pagesVisited: z.array(z.string()).optional(),
        counts: z.object({
            attempted: z.number(),
            succeeded: z.number(),
            failed: z.number()
        }).optional(),
        recentActions: z.array(z.object({
            action: z.string().optional(),
            target: z.string().nullable().optional(),
            outcome: z.string().optional(),
            verified: z.boolean().optional()
        })).optional(),
        completedSubgoals: z.array(z.string()).optional(),
        currentSubgoal: z.string().nullable().optional(),
        userInterventions: z.array(z.object({
            field: z.string().optional(),
            label: z.string().optional()
        })).optional(),
        confirmations: z.array(z.string()).optional(),
        activeBlockers: z.array(z.string()).optional(),
        staleSelectors: z.array(z.string()).optional()
    }).nullable().optional()
});

export default requestSchema;

