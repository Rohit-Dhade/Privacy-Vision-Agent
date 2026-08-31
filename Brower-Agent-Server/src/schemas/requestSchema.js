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
    hasValue: z.boolean().optional()
})

const redactionEntrySchema = z.object({
    elementId: z.string(),
    type: z.string(),
    method: z.enum(["blackout", "blur"]),
})


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
    actionHistory: z.array(z.any()),
});

export default requestSchema;

