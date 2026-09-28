import { z } from "zod";

const actionSchema = z.object({
    action: z.enum([
        "click",
        "fill",
        "type",
        "clear",
        "select",
        "check",
        "uncheck",
        "radio",
        "hover",
        "focus",
        "press_key",
        "scroll",
        "navigate",
        "back",
        "forward",
        "extract",
        "wait",
        "done",
        "fill_from_local",
        "ask_user",
        "notify_submit",
        "upload",
        "replan"
    ]),
    targetSelector: z.string().nullable().optional(),
    value: z.string().nullable().optional(),
    reasoning: z.string(),
    plan: z.object({
        objective: z.string().optional(),
        currentSubgoal: z.string().optional(),
        subgoalCompleted: z.boolean().optional(),
        gatheredInfo: z.record(z.string(), z.any()).optional(),
        isTaskComplete: z.boolean().optional()
    }).nullable().optional(),
    suggestion: z.object({
        type: z.enum(["FORM_PROGRESS", "USER_ATTENTION", "AUTOMATION_AVAILABLE", "NAVIGATION_PROGRESS", "COMPLETION"]),
        message: z.string()
    }).nullable().optional(),
    hitlRequest: z.object({
        category: z.enum([
            "AUTHENTICATION",
            "CAPTCHA",
            "SENSITIVE_CREDENTIAL",
            "AMBIGUOUS_DECISION",
            "PERMISSION",
            "CLARIFICATION",
            "APPROVAL",
            "OUTSIDE_AUTHORITY",
            "MISSING_INFO"
        ]).optional(),
        whyBlocked: z.string().optional(),
        userActionRequired: z.string().optional(),
        nextStepPlan: z.string().optional(),
        targetContext: z.string().optional(),
        choices: z.array(z.string()).optional()
    }).nullable().optional(),
    visualGrounding: z.object({
        approximatePoint: z.object({
            x: z.number(),
            y: z.number()
        }).optional(),
        spatialContext: z.string().optional(),
        visualGroup: z.string().optional()
    }).nullable().optional()
});

export default actionSchema;